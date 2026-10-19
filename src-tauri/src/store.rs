//! SQLite persistence for tracking sessions (telemetry + events + reports).
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TargetMeta {
    pub pid: u32,
    pub name: String,
    pub start: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionMeta {
    pub id: i64,
    pub name: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub limit_s: Option<u64>,
    pub status: String, // running | completed | stopped | exited
    pub include_children: bool,
    pub targets: Vec<TargetMeta>,
    pub has_report: bool,
    pub has_ai: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SampleRow {
    pub t: u64,
    pub pid: u32,
    pub cpu: f32,
    pub mem: u64,
    pub dr: u64,
    pub dw: u64,
    pub nr: u64,
    pub nw: u64,
    pub thr: u32,
    pub n: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EventRow {
    pub t: u64,
    pub pid: u32,
    pub kind: String,
    pub severity: String,
    pub message: String,
}

#[derive(Serialize)]
pub struct SessionDetail {
    pub meta: SessionMeta,
    pub report: Option<serde_json::Value>,
    pub ai_report: Option<String>,
    pub ai_error: Option<String>,
    pub events: Vec<EventRow>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &std::path::Path) -> AppResult<Self> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS sessions(
               id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, started_at INTEGER NOT NULL,
               ended_at INTEGER, limit_s INTEGER, status TEXT NOT NULL, include_children INTEGER NOT NULL,
               targets TEXT NOT NULL, report TEXT, ai_report TEXT, ai_error TEXT);
             CREATE TABLE IF NOT EXISTS samples(
               session_id INTEGER NOT NULL, pid INTEGER NOT NULL, t INTEGER NOT NULL, cpu REAL, mem INTEGER,
               dr INTEGER, dw INTEGER, nr INTEGER, nw INTEGER, thr INTEGER, n INTEGER);
             CREATE INDEX IF NOT EXISTS samples_s ON samples(session_id, pid, t);
             CREATE TABLE IF NOT EXISTS events(
               session_id INTEGER NOT NULL, t INTEGER NOT NULL, pid INTEGER, kind TEXT, severity TEXT, message TEXT);
             CREATE INDEX IF NOT EXISTS events_s ON events(session_id, t);",
        )?;
        // Sessions left "running" by a crash/quit are closed as stopped.
        conn.execute("UPDATE sessions SET status='stopped', ended_at=COALESCE(ended_at, started_at) WHERE status='running'", [])?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn create_session(&self, name: &str, started: u64, limit_s: Option<u64>, include_children: bool, targets: &[TargetMeta]) -> AppResult<i64> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO sessions(name, started_at, limit_s, status, include_children, targets) VALUES (?,?,?,?,?,?)",
            params![name, started as i64, limit_s.map(|x| x as i64), "running", include_children, serde_json::to_string(targets)?],
        )?;
        Ok(c.last_insert_rowid())
    }

    pub fn finish_session(&self, id: i64, ended: u64, status: &str, report: &serde_json::Value) -> AppResult<()> {
        self.conn.lock().execute(
            "UPDATE sessions SET ended_at=?, status=?, report=? WHERE id=?",
            params![ended as i64, status, report.to_string(), id],
        )?;
        Ok(())
    }

    pub fn insert_samples(&self, id: i64, rows: &[SampleRow]) -> AppResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare_cached("INSERT INTO samples VALUES (?,?,?,?,?,?,?,?,?,?,?)")?;
            for r in rows {
                st.execute(params![id, r.pid, r.t as i64, r.cpu, r.mem as i64, r.dr as i64, r.dw as i64, r.nr as i64, r.nw as i64, r.thr, r.n])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn insert_events(&self, id: i64, rows: &[EventRow]) -> AppResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        {
            let mut st = tx.prepare_cached("INSERT INTO events VALUES (?,?,?,?,?,?)")?;
            for e in rows {
                st.execute(params![id, e.t as i64, e.pid, e.kind, e.severity, e.message])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    fn meta_from(r: &rusqlite::Row) -> rusqlite::Result<SessionMeta> {
        let targets: String = r.get(7)?;
        Ok(SessionMeta {
            id: r.get(0)?,
            name: r.get(1)?,
            started_at: r.get::<_, i64>(2)? as u64,
            ended_at: r.get::<_, Option<i64>>(3)?.map(|x| x as u64),
            limit_s: r.get::<_, Option<i64>>(4)?.map(|x| x as u64),
            status: r.get(5)?,
            include_children: r.get(6)?,
            targets: serde_json::from_str(&targets).unwrap_or_default(),
            has_report: r.get::<_, Option<String>>(8)?.is_some(),
            has_ai: r.get::<_, Option<String>>(9)?.is_some(),
        })
    }

    pub fn list_sessions(&self) -> AppResult<Vec<SessionMeta>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id,name,started_at,ended_at,limit_s,status,include_children,targets,
                    CASE WHEN report IS NULL THEN NULL ELSE '1' END, CASE WHEN ai_report IS NULL THEN NULL ELSE '1' END
             FROM sessions ORDER BY id DESC LIMIT 200",
        )?;
        let rows = st.query_map([], Self::meta_from)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_session(&self, id: i64) -> AppResult<SessionDetail> {
        let c = self.conn.lock();
        let (meta, report, ai, err) = c
            .query_row(
                "SELECT id,name,started_at,ended_at,limit_s,status,include_children,targets,report,ai_report,ai_error FROM sessions WHERE id=?",
                [id],
                |r| {
                    let report: Option<String> = r.get(8)?;
                    let ai: Option<String> = r.get(9)?;
                    let err: Option<String> = r.get(10)?;
                    let mut m = Self::meta_from(r)?;
                    m.has_report = report.is_some();
                    m.has_ai = ai.is_some();
                    Ok((m, report, ai, err))
                },
            )
            .map_err(|_| AppError::NotFound("Session not found".into()))?;
        let mut st = c.prepare("SELECT t,pid,kind,severity,message FROM events WHERE session_id=? ORDER BY t LIMIT 2000")?;
        let events = st
            .query_map([id], |r| Ok(EventRow { t: r.get::<_, i64>(0)? as u64, pid: r.get(1)?, kind: r.get(2)?, severity: r.get(3)?, message: r.get(4)? }))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SessionDetail { meta, report: report.and_then(|s| serde_json::from_str(&s).ok()), ai_report: ai, ai_error: err, events })
    }

    /// Samples for one target, thinned to at most `max_points` by striding.
    pub fn samples(&self, id: i64, pid: u32, max_points: usize) -> AppResult<Vec<SampleRow>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT t,pid,cpu,mem,dr,dw,nr,nw,thr,n FROM samples WHERE session_id=? AND pid=? ORDER BY t")?;
        let all = st
            .query_map(params![id, pid], |r| {
                Ok(SampleRow { t: r.get::<_, i64>(0)? as u64, pid: r.get(1)?, cpu: r.get::<_, f64>(2)? as f32, mem: r.get::<_, i64>(3)? as u64, dr: r.get::<_, i64>(4)? as u64, dw: r.get::<_, i64>(5)? as u64, nr: r.get::<_, i64>(6)? as u64, nw: r.get::<_, i64>(7)? as u64, thr: r.get(8)?, n: r.get(9)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if all.len() <= max_points {
            return Ok(all);
        }
        let stride = all.len().div_ceil(max_points);
        Ok(all.into_iter().step_by(stride).collect())
    }

    pub fn set_ai(&self, id: i64, text: Option<&str>, err: Option<&str>) -> AppResult<()> {
        self.conn.lock().execute("UPDATE sessions SET ai_report=?, ai_error=? WHERE id=?", params![text, err, id])?;
        Ok(())
    }

    pub fn delete_session(&self, id: i64) -> AppResult<()> {
        let c = self.conn.lock();
        for t in ["samples", "events"] {
            c.execute(&format!("DELETE FROM {t} WHERE session_id=?"), [id])?;
        }
        c.execute("DELETE FROM sessions WHERE id=?", [id])?;
        Ok(())
    }

    pub fn prune(&self, older_than_ms: u64) -> AppResult<()> {
        let ids: Vec<i64> = {
            let c = self.conn.lock();
            let mut st = c.prepare("SELECT id FROM sessions WHERE started_at < ? AND status != 'running'")?;
            let v = st.query_map([older_than_ms as i64], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
            v
        };
        for id in ids {
            self.delete_session(id)?;
        }
        Ok(())
    }
}
