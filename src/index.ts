import express, { Request, Response, NextFunction } from 'express';
// @ts-ignore - sql.js ships its own JS bundle
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

type DayStats = {
  date: string;
  steps: number;
  activeKcal: number;     // we keep your 1745 resting assumption separate
  totalKcal: number;      // activeKcal + 1745 (fixed)
  workoutCount: number;
  workoutMinutes: number;
  workoutNames: string[];
};

const DB_FILE = path.resolve('activity_data.sqlite');

async function loadDb() {
  let buf = new Uint8Array();
  if (fs.existsSync(DB_FILE)) buf = fs.readFileSync(DB_FILE);
  const SQL = await initSqlJs({
    locateFile: (f: string) => `node_modules/sql.js/dist/${f}`
  });
  return new SQL.Database(buf);
}

// ---- Basic Auth (username fixed = "user"; password = env BASIC_PASSWORD or public IP) ----
let BASIC_USER = process.env.BASIC_USER || 'user';
let BASIC_PASSWORD = process.env.BASIC_PASSWORD || ''; // if empty we fallback to public IP

async function fetchPublicIP(): Promise<string> {
  const res = await fetch('https://api.ipify.org');
  return (await res.text()).trim();
}

async function resolvePassword() {
  if (process.env.BASIC_PASSWORD && process.env.BASIC_PASSWORD.length > 0) {
    BASIC_PASSWORD = process.env.BASIC_PASSWORD;
    console.log('🔒 Basic-Auth password (from env):', BASIC_PASSWORD);
  } else {
    try {
      BASIC_PASSWORD = await fetchPublicIP();
      console.log('🔒 Basic-Auth password (your public IP):', BASIC_PASSWORD);
    } catch {
      console.warn('⚠️ Could not fetch public IP; BASIC_PASSWORD is empty (auth will fail). Set BASIC_PASSWORD env to fix.');
    }
  }
}

function basicAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASSWORD}`).toString('base64');
  if (header === expected) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Protected"');
  return res.status(401).send('Auth required');
}

// ---- Main ----
async function main() {
  await resolvePassword();
  // auto refresh password every 6h if using IP mode
  if (!process.env.BASIC_PASSWORD) {
    setInterval(resolvePassword, 6 * 60 * 60 * 1000);
  }

  const db: any = await loadDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS day_stats (
      date TEXT PRIMARY KEY,
      steps INTEGER,
      activeKcal REAL,
      workoutCount INTEGER,
      workoutMinutes REAL,
      workoutNames TEXT
    );
  `);

  const dayMap = new Map<string, DayStats>();
  const res0 = db.exec('SELECT * FROM day_stats;');
  if (res0.length) {
    const { columns, values } = res0[0];
    values.forEach((row: any[]) => {
      const rec: any = {};
      columns.forEach((col: string, i: number) => (rec[col] = row[i]));
      const total = (rec.activeKcal || 0) + 1745; // your fixed resting kcal
      dayMap.set(rec.date, {
        date: rec.date,
        steps: rec.steps || 0,
        activeKcal: rec.activeKcal || 0,
        totalKcal: total,
        workoutCount: rec.workoutCount || 0,
        workoutMinutes: rec.workoutMinutes || 0,
        workoutNames: rec.workoutNames ? rec.workoutNames.split(',') : [],
      });
    });
  }

  function saveDay(d: string, s: DayStats) {
    const names = s.workoutNames.join(',');
    db.run(
      `
      INSERT INTO day_stats
        (date,steps,activeKcal,workoutCount,workoutMinutes,workoutNames)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        steps=excluded.steps,
        activeKcal=excluded.activeKcal,
        workoutCount=excluded.workoutCount,
        workoutMinutes=excluded.workoutMinutes,
        workoutNames=excluded.workoutNames;
    `,
      [d, s.steps, s.activeKcal, s.workoutCount, s.workoutMinutes, names]
    );
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  }

  const app = express();

  // tiny request log
  app.use((req, _res, next) => {
    console.log(`→ ${req.method} ${req.url}`);
    next();
  });

  app.use(express.json({ limit: '100mb' }));

  // Protect endpoints with Basic Auth. If you want the dashboard public, move basicAuth below GET /.
  app.use(basicAuth);

  // ingest steps + energy
  app.post('/steps', (req: Request, res: Response) => {
    (req.body?.data?.metrics || []).forEach((m: any) => {
      const { name, units, data = [] } = m;

      if (name === 'step_count') {
        data.forEach((r: any) => {
          const d = r.date.split(' ')[0];
          const st = Math.round(r.qty);
          const prev = dayMap.get(d) || {
            date: d,
            steps: 0,
            activeKcal: 0,
            totalKcal: 0,
            workoutCount: 0,
            workoutMinutes: 0,
            workoutNames: [],
          };
          prev.steps = st;
          prev.totalKcal = prev.activeKcal + 1745;
          dayMap.set(d, prev);
          saveDay(d, prev);
        });
      }

      if (name === 'active_energy') {
        data.forEach((r: any) => {
          const d = r.date.split(' ')[0];
          const qty = units === 'kJ' ? r.qty / 4.184 : r.qty;
          const prev = dayMap.get(d) || {
            date: d,
            steps: 0,
            activeKcal: 0,
            totalKcal: 0,
            workoutCount: 0,
            workoutMinutes: 0,
            workoutNames: [],
          };
          prev.activeKcal += qty;
          prev.totalKcal = prev.activeKcal + 1745;
          dayMap.set(d, prev);
          saveDay(d, prev);
        });
      }
    });
    res.sendStatus(200);
  });

  // ingest workouts
  app.post('/workouts', (req: Request, res: Response) => {
    const list = req.body?.data?.workouts;
    if (!Array.isArray(list)) {
      res.status(400).send('Invalid workout payload');
      return;
    }
    list.forEach((w: any) => {
      const d = (w.start || '').split(' ')[0] || 'unknown';
      const mins = (w.duration || 0) / 60;
      const kcal = w.activeEnergyBurned
        ? w.activeEnergyBurned.units === 'kJ'
          ? w.activeEnergyBurned.qty / 4.184
          : w.activeEnergyBurned.qty
        : 0;

      const prev = dayMap.get(d) || {
        date: d,
        steps: 0,
        activeKcal: 0,
        totalKcal: 0,
        workoutCount: 0,
        workoutMinutes: 0,
        workoutNames: [],
      };
      prev.workoutCount += 1;
      prev.workoutMinutes += mins;
      prev.activeKcal += kcal;
      prev.totalKcal = prev.activeKcal + 1745;
      if (w.name) prev.workoutNames = [...new Set([...(prev.workoutNames || []), w.name])];
      dayMap.set(d, prev);
      saveDay(d, prev);
    });
    res.sendStatus(200);
  });

  // raw JSON for charts/tables
  app.get('/api/daily', (_req, res) => {
    const data = [...dayMap.values()].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    res.json(data);
  });

  // dashboard (protected by basicAuth above)
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.listen(4000, () => {
    console.log('Listening on http://localhost:4000');
    console.log(`🔑 Basic auth user: ${BASIC_USER}`);
    console.log(`🔑 Basic auth password: ${BASIC_PASSWORD || '(empty!)'}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
