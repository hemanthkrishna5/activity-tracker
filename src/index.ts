import express, { Request, Response, NextFunction } from 'express';
// @ts-ignore
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

type DayStats = {
  date: string;
  steps: number;
  activeKcal: number;
  totalKcal: number;
  workoutCount: number;
  workoutMinutes: number;
  workoutNames: string[];
};

async function main() {
  const DB_FILE = path.resolve('activity_data.sqlite');
  let buf = new Uint8Array();
  if (fs.existsSync(DB_FILE)) buf = fs.readFileSync(DB_FILE);

  const SQL = await initSqlJs({
    locateFile: (f: string) => `node_modules/sql.js/dist/${f}`,
  });
  const db: any = new SQL.Database(buf);

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
      const total = (rec.activeKcal || 0) + 1745;
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
  app.use((req, _res, next: NextFunction) => {
    console.log(`→ ${req.method} ${req.url}`);
    next();
  });
  app.use(express.json({ limit: '100mb' }));

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

  app.post('/workouts', (req: Request, res: Response) => {
    const list = req.body?.data?.workouts;
    if (!Array.isArray(list)) {
      res.status(400).send('Invalid workout payload');
      return;
    }
    list.forEach((w: any) => {
      const d = w.start.split(' ')[0];
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

  app.get('/api/daily', (_req, res) => {
    const data = [...dayMap.values()].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    res.json(data);
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  app.listen(4000, () => console.log('listening on 4000'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
