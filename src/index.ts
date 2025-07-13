import express, { Request, Response, NextFunction } from 'express';
// @ts-ignore
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

type DayStats = {
  date: string;
  steps: number;
  activeKcal: number;
  restingKcal: number;
  totalKcal: number;
  workoutCount: number;
  workoutMinutes: number;
  workoutNames: string[];
};

async function main() {
  // — load/create SQLite file —
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
      restingKcal REAL,
      workoutCount INTEGER,
      workoutMinutes REAL,
      workoutNames TEXT
    );
  `);

  // — in-memory mirror —
  const dayMap = new Map<string, DayStats>();
  const res0 = db.exec('SELECT * FROM day_stats;');
  if (res0.length) {
    const { columns, values } = res0[0];
    values.forEach((row: any[]) => {
      const rec: any = {};
      columns.forEach((col: string, i: number) => (rec[col] = row[i]));
      const total = (rec.activeKcal || 0) + (rec.restingKcal || 0);
      dayMap.set(rec.date, {
        date: rec.date,
        steps: rec.steps || 0,
        activeKcal: rec.activeKcal || 0,
        restingKcal: rec.restingKcal || 0,
        totalKcal: total,
        workoutCount: rec.workoutCount || 0,
        workoutMinutes: rec.workoutMinutes || 0,
        workoutNames: rec.workoutNames ? rec.workoutNames.split(',') : [],
      });
    });
  }

  // — persist helper —
  function saveDay(d: string, s: DayStats) {
    const names = s.workoutNames.join(',');
    db.run(
      `
      INSERT INTO day_stats
        (date,steps,activeKcal,restingKcal,workoutCount,workoutMinutes,workoutNames)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET
        steps=excluded.steps,
        activeKcal=excluded.activeKcal,
        restingKcal=excluded.restingKcal,
        workoutCount=excluded.workoutCount,
        workoutMinutes=excluded.workoutMinutes,
        workoutNames=excluded.workoutNames;
    `,
      [d, s.steps, s.activeKcal, s.restingKcal, s.workoutCount, s.workoutMinutes, names]
    );
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  }

  // — Express setup —
  const app = express();
  app.use((req, _res, next: NextFunction) => {
    console.log(`→ ${req.method} ${req.url}`);
    next();
  });
  app.use(express.json({ limit: '100mb' }));

  // — ingest steps & energy —
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
            restingKcal: 0,
            totalKcal: 0,
            workoutCount: 0,
            workoutMinutes: 0,
            workoutNames: [],
          };
          prev.steps = st;
          prev.totalKcal = prev.activeKcal + prev.restingKcal;
          dayMap.set(d, prev);
          saveDay(d, prev);
        });
      }
      if (name === 'active_energy' || name === 'basal_energy_burned') {
        const field = name === 'active_energy' ? 'activeKcal' : 'restingKcal';
        data.forEach((r: any) => {
          const d = r.date.split(' ')[0];
          const qty = units === 'kJ' ? r.qty / 4.184 : r.qty;
          const prev = dayMap.get(d) || {
            date: d,
            steps: 0,
            activeKcal: 0,
            restingKcal: 0,
            totalKcal: 0,
            workoutCount: 0,
            workoutMinutes: 0,
            workoutNames: [],
          };
          prev[field] = (prev[field] || 0) + qty;
          prev.totalKcal = prev.activeKcal + prev.restingKcal;
          dayMap.set(d, prev);
          saveDay(d, prev);
        });
      }
    });
    res.sendStatus(200);
  });

  // — ingest workouts —
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
        restingKcal: 0,
        totalKcal: 0,
        workoutCount: 0,
        workoutMinutes: 0,
        workoutNames: [],
      };
      prev.workoutCount = (prev.workoutCount || 0) + 1;
      prev.workoutMinutes = (prev.workoutMinutes || 0) + mins;
      prev.activeKcal = (prev.activeKcal || 0) + kcal;
      prev.totalKcal = prev.activeKcal + prev.restingKcal;
      if (w.name) prev.workoutNames = [...new Set([...(prev.workoutNames || []), w.name])];
      dayMap.set(d, prev);
      saveDay(d, prev);
    });
    res.sendStatus(200);
  });

  // — raw JSON for charts + table —
  app.get('/api/daily', (_req, res) => {
    const data = [...dayMap.values()].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    res.json(data);
  });

  // — Dashboard + charts + sortable table —
  app.get('/', (_req, res) => {
    res.send(`<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Activity Dashboard</title>
  <style>
    body { font-family: sans-serif; margin:2rem; }
    canvas { max-width:100%; height:auto; margin-bottom:2rem; }
    table { border-collapse: collapse; width:100%; margin-top:2rem; }
    th, td { border:1px solid #ccc; padding:0.4rem; text-align:center; }
    th { cursor: pointer; background:#f6f6f6; }
    th:hover { background:#eee; }
    th.sorted.asc::after { content:" ▲"; }
    th.sorted.desc::after { content:" ▼"; }
    td:nth-child(8) { text-align:left; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head><body>
  <h1>🏃‍♂️ Daily Activity Overview</h1>

  <canvas id="stepsChart"></canvas>
  <canvas id="kcalChart"></canvas>
  <canvas id="monthChart"></canvas>

  <h2>📊 Daily Data Table</h2>
  <div id="tableContainer"></div>

  <script>
    let dailyData = [];
    let currentSort = { idx: 0, asc: true };

    async function fetchData() {
      dailyData = await fetch('/api/daily').then(r=>r.json());
      dailyData.forEach(r=>r.date = new Date(r.date));
      buildCharts();
      buildTable(dailyData);
    }

    function fmt(d) {
      return d.toLocaleDateString('en-GB');
    }

    function buildCharts() {
      // 1) Daily Steps Line
      new Chart(document.getElementById('stepsChart'), {
        type:'line',
        data:{
          labels: dailyData.map(r=>fmt(r.date)),
          datasets:[{
            label:'Steps', data: dailyData.map(r=>r.steps),
            borderColor:'dodgerblue', tension:0.3, fill:false
          }]
        },
        options:{
          responsive:true,
          plugins:{ title:{ display:true, text:'Daily Steps' }}
        }
      });

      // 2) Daily kcal stacked bar
      new Chart(document.getElementById('kcalChart'), {
        type:'bar',
        data:{
          labels: dailyData.map(r=>fmt(r.date)),
          datasets:[
            { label:'Active',  data: dailyData.map(r=>r.activeKcal),   backgroundColor:'orange' },
            { label:'Resting', data: dailyData.map(r=>r.restingKcal),  backgroundColor:'seagreen' },
            { label:'Total',   data: dailyData.map(r=>r.totalKcal),    backgroundColor:'crimson' }
          ]
        },
        options:{
          responsive:true,
          plugins:{ title:{ display:true, text:'Daily kcal (stacked)' }},
          scales:{ x:{ stacked:true }, y:{ stacked:true } }
        }
      });

      // 3) Monthly steps
      const mmap = {};
      dailyData.forEach(r=>{
        const key = \`\${r.date.getFullYear()}-\${String(r.date.getMonth()+1).padStart(2,'0')}\`;
        mmap[key] = (mmap[key]||0) + r.steps;
      });
      const months = Object.entries(mmap).sort();
      new Chart(document.getElementById('monthChart'), {
        type:'bar',
        data:{
          labels: months.map(([m])=>m),
          datasets:[{
            label:'Monthly Steps',
            data: months.map(([,v])=>v),
            backgroundColor: 'steelblue'
          }]
        },
        options:{
          responsive:true,
          plugins:{ title:{ display:true, text:'Monthly Steps' }}
        }
      });
    }

    function buildTable(data) {
      const container = document.getElementById('tableContainer');
      container.innerHTML = ''; // reset

      const table = document.createElement('table');
      const headers = ['Date','Steps','Active kcal','Resting kcal','Total kcal','#Workouts','Minutes','Workout Names'];
      const thead = document.createElement('thead');
      const hrow = document.createElement('tr');

      headers.forEach((h,i)=>{
        const th = document.createElement('th');
        th.textContent = h;
        th.addEventListener('click', ()=> sortBy(i, th));
        hrow.appendChild(th);
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      data.forEach(r=>{
        const tr = document.createElement('tr');
        [
          fmt(r.date),
          r.steps,
          r.activeKcal.toFixed(0),
          r.restingKcal.toFixed(0),
          r.totalKcal.toFixed(0),
          r.workoutCount,
          r.workoutMinutes.toFixed(1),
          r.workoutNames.join(', ')
        ].forEach(val=>{
          const td = document.createElement('td');
          td.textContent = val;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      container.appendChild(table);
      // re‐apply sorted class to header
      Array.from(thead.querySelectorAll('th')).forEach((th, idx)=>{
        th.classList.toggle('sorted', idx===currentSort.idx);
        th.classList.toggle(currentSort.asc?'asc':'desc', idx===currentSort.idx);
      });
    }

    function sortBy(idx, clickedTh) {
      // toggle direction if same column
      if (currentSort.idx === idx) currentSort.asc = !currentSort.asc;
      else { currentSort.idx = idx; currentSort.asc = true; }
      dailyData.sort((a,b)=>{
        let vA, vB;
        switch(idx){
          case 0: vA=a.date;    vB=b.date;    break;
          case 1: vA=a.steps;   vB=b.steps;   break;
          case 2: vA=a.activeKcal;   vB=b.activeKcal;   break;
          case 3: vA=a.restingKcal;  vB=b.restingKcal;  break;
          case 4: vA=a.totalKcal;    vB=b.totalKcal;    break;
          case 5: vA=a.workoutCount; vB=b.workoutCount; break;
          case 6: vA=a.workoutMinutes; vB=b.workoutMinutes; break;
          case 7: vA=a.workoutNames.join(','); vB=b.workoutNames.join(','); break;
          default: vA='', vB='';
        }
        if (vA>vB) return currentSort.asc?1:-1;
        if (vA<vB) return currentSort.asc?-1:1;
        return 0;
      });
      buildTable(dailyData);
    }

    fetchData();
  </script>
</body></html>`);
  });

  app.listen(4000, () => console.log('listening on 4000'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
