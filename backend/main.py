# -*- coding: utf-8 -*-
"""
PMC 后端服务 (FastAPI)
- 静态托管 frontend/
- 数据录入 API: 每日线体达成记录 (SQLite 存储)
- 预测 API: 移动平均 / 指数平滑 / 线性回归 (可选 Prophet)
- 供 GitHub Pages 前端在本地增强模式下调用

启动: uvicorn main:app --reload --port 8000
"""
import json
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
FRONTEND_DIR = ROOT_DIR
DATA_DIR = os.path.join(ROOT_DIR, "data")
DB_PATH = os.path.join(BASE_DIR, "pmc.db")

app = FastAPI(title="PMC 生产制造管理系统 API", version="1.0.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# --------------------------------------------------------------------------
# 数据库
# --------------------------------------------------------------------------

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                line TEXT NOT NULL,
                shift TEXT DEFAULT '白班',
                model TEXT DEFAULT '',
                target REAL DEFAULT 0,
                output_qty REAL DEFAULT 0,
                input_qty REAL DEFAULT 0,
                headcount REAL DEFAULT 0,
                loss_reason TEXT DEFAULT '',
                achieve_rate REAL DEFAULT 0,
                diff REAL DEFAULT 0,
                created_at TEXT
            )"""
        )


init_db()


class RecordIn(BaseModel):
    date: str
    line: str
    shift: str = "白班"
    model: str = ""
    target: float = 0
    output_qty: float = 0
    input_qty: float = 0
    headcount: float = 0
    loss_reason: str = ""


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok", "time": datetime.now().isoformat()}


@app.get("/api/data/{name}")
def get_data(name: str):
    """读取 frontend/data 下的 JSON 数据文件"""
    safe = os.path.basename(name)
    if not safe.endswith(".json"):
        raise HTTPException(400, "仅支持 json 文件")
    path = os.path.join(DATA_DIR, safe)
    if not os.path.exists(path):
        raise HTTPException(404, "文件不存在")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/records")
def list_records(date: Optional[str] = None, line: Optional[str] = None, limit: int = 500):
    sql = "SELECT * FROM records WHERE 1=1"
    args: list = []
    if date:
        sql += " AND date=?"; args.append(date)
    if line:
        sql += " AND line=?"; args.append(line)
    sql += " ORDER BY date DESC, id DESC LIMIT ?"; args.append(limit)
    with db() as conn:
        rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
    return {"count": len(rows), "records": rows}


@app.post("/api/records")
def add_record(r: RecordIn):
    rate = (r.output_qty / r.target) if r.target else 0
    diff = r.output_qty - r.target
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO records (date,line,shift,model,target,output_qty,input_qty,headcount,loss_reason,achieve_rate,diff,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (r.date, r.line, r.shift, r.model, r.target, r.output_qty,
             r.input_qty, r.headcount, r.loss_reason, round(rate, 4), diff,
             datetime.now().isoformat()),
        )
        rid = cur.lastrowid
    return {"id": rid, "achieve_rate": round(rate, 4), "diff": diff}


@app.delete("/api/records/{rid}")
def delete_record(rid: int):
    with db() as conn:
        cur = conn.execute("DELETE FROM records WHERE id=?", (rid,))
    if cur.rowcount == 0:
        raise HTTPException(404, "记录不存在")
    return {"deleted": cur.rowcount}


@app.get("/api/forecast")
def forecast(process: str = "ALL", method: str = "ma", periods: int = 5):
    """基于日报数据预测未来产能 (纯 Python 实现)"""
    path = os.path.join(DATA_DIR, "daily.json")
    if not os.path.exists(path):
        raise HTTPException(404, "daily.json 不存在, 请先运行 tools/build_data.py")
    with open(path, encoding="utf-8") as f:
        daily = json.load(f)

    recs = []
    for v in daily.values():
        recs.extend(v or [])

    series = {}
    for r in recs:
        if process != "ALL" and r.get("process") != process:
            continue
        d = r.get("date")
        if not d:
            continue
        s = series.setdefault(d, {"output": 0.0, "target": 0.0})
        s["output"] += r.get("output_qty") or 0
        s["target"] += r.get("target") or 0

    keys = sorted(series)
    outputs = [series[k]["output"] for k in keys]
    rates = [(series[k]["output"] / series[k]["target"]) if series[k]["target"] else 0 for k in keys]

    def ma(vals, w=3):
        return [sum(vals[max(0, i - w + 1):i + 1]) / len(vals[max(0, i - w + 1):i + 1]) for i in range(len(vals))]

    def ema(vals, a=0.35):
        out, prev = [], None
        for i, v in enumerate(vals):
            prev = v if i == 0 else a * v + (1 - a) * prev
            out.append(prev)
        return out

    def linreg(vals):
        n = len(vals)
        if not n:
            return 0, 0
        sx, sy = sum(range(n)), sum(vals)
        sxy = sum(i * v for i, v in enumerate(vals))
        sxx = sum(i * i for i in range(n))
        den = n * sxx - sx * sx
        slope = (n * sxy - sx * sy) / den if den else 0
        return slope, (sy - slope * sx) / n

    if method == "ema":
        smooth = ema(outputs)
        rate_smooth = ema(rates)
        predicts = [smooth[-1] if smooth else 0] * periods
    elif method == "linreg":
        slope, intercept = linreg(outputs)
        smooth = [intercept + slope * i for i in range(len(outputs))]
        predicts = [intercept + slope * (len(outputs) - 1 + i) for i in range(1, periods + 1)]
    else:
        smooth = ma(outputs)
        predicts = [smooth[-1] if smooth else 0] * periods
        rate_smooth = ma(rates)

    next_rate = rate_smooth[-1] if rate_smooth else 0
    return {
        "process": process,
        "method": method,
        "dates": keys,
        "history": [round(v, 1) for v in smooth],
        "raw_output": outputs,
        "predict": [round(v, 1) for v in predicts],
        "avg_rate": round(sum(rates) / len(rates), 4) if rates else 0,
        "next_rate": round(min(next_rate, 1.15), 4),
    }


# --------------------------------------------------------------------------
# 静态托管 frontend (放最后, 避免覆盖 /api)
# --------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
