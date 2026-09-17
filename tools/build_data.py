# -*- coding: utf-8 -*-
"""
PMC 数据构建脚本
读取富智康 LE0 的 Excel 资料，生成前端可用的结构化 JSON 数据。
输出目录: frontend/data/
"""
import os
import json
import glob
import re
from datetime import datetime, date
from collections import defaultdict

import pandas as pd

SRC_ROOT = r"D:\BaiduNetdiskDownload\PMC\富智康资料\工作资料\LE0工作資料\LE0工作資料"
DA_CHENG_DIR = os.path.join(SRC_ROOT, "達成")
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
FULL_DIR = os.path.join(OUT_DIR, "full")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(FULL_DIR, exist_ok=True)

MASTER_PLAN = os.path.join(SRC_ROOT, "LE0 UPH-2026.08.06（EA pro16.6）.xlsx")


def _num(x):
    if x is None:
        return None
    try:
        if pd.isna(x):
            return None
        v = float(x)
        if v != v or v in (float("inf"), float("-inf")):
            return None
        return round(v, 4)
    except (TypeError, ValueError):
        return None


def _s(x):
    if x is None:
        return None
    try:
        if pd.isna(x):
            return None
        s = str(x).strip()
        return s if s and s.lower() != "nan" else None
    except Exception:
        return None


def _date_str(x):
    s = _s(x)
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S.%f", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


# ---------------------------------------------------------------------------
# 1. 线体基础资料 & UPH
# ---------------------------------------------------------------------------
def build_lines():
    if not os.path.exists(MASTER_PLAN):
        print("[skip] 线体 UPH 文件不存在:", MASTER_PLAN)
        return []
    df = pd.read_excel(MASTER_PLAN, header=None)
    lines = []
    cur_process = None
    cur_floor = None
    for i, row in df.iterrows():
        date_v = _date_str(row.iloc[0])
        line = _s(row.iloc[4])
        process = _s(row.iloc[2]) or _s(row.iloc[1])
        if process:
            cur_process = process
        if line in (None, "線體", "线体", "/"):
            continue
        floor = _s(row.iloc[3])
        if floor:
            cur_floor = floor
        line_desc = _s(row.iloc[5])
        uph = _num(row.iloc[6])
        hourly = _num(row.iloc[7])
        daily = _num(row.iloc[8])
        daily_ttl = _num(row.iloc[9])
        mfg_hr = _num(row.iloc[10])
        qc_hr = _num(row.iloc[11])
        note = _s(row.iloc[12])
        lines.append({
            "id": f"{cur_process or 'NA'}_{line}",
            "line": line,
            "process": cur_process or "NA",
            "floor": cur_floor,
            "desc": line_desc or "",
            "uph": uph,
            "hourly_output": hourly,
            "daily_output": daily,
            "daily_ttl_output": daily_ttl,
            "mfg_hr": mfg_hr,
            "qc_hr": qc_hr,
            "note": note or "",
            "base_date": date_v,
        })
    return lines


# ---------------------------------------------------------------------------
# 2. 达成记录 / 月度达成率
# ---------------------------------------------------------------------------
def build_monthly_achievement():
    pattern = os.path.join(DA_CHENG_DIR, "LE0*達成記錄*.xlsx")
    files = glob.glob(pattern)
    if not files:
        pattern = os.path.join(DA_CHENG_DIR, "LE0*达成*.xlsx")
        files = glob.glob(pattern)
    latest = None
    for f in files:
        m = re.search(r"(\d{6,8})", os.path.basename(f))
        key = m.group(1) if m else "0"
        if latest is None or key > latest[0]:
            latest = (key, f)
    if latest is None:
        print("[skip] 未找到达成记录文件")
        return []
    path = latest[1]
    print("[read] 达成记录:", os.path.basename(path))

    xl = pd.ExcelFile(path)
    result = {"meta": {"source": os.path.basename(path), "updated": datetime.now().strftime("%Y-%m-%d")},
              "monthly": [], "by_year": [], "by_day": []}

    # ---- 月达成率 sheet ----
    if "月达成率" in xl.sheet_names:
        raw = xl.parse("月达成率", header=None)
        # 解析第3-5行定位表头
        header_info = {}
        for i in range(min(6, len(raw))):
            for j in range(raw.shape[1]):
                v = _s(raw.iloc[i, j])
                if v:
                    header_info.setdefault(v, []).append((i, j))

        process_map = {}  # (row, col)-> process; columns hold year/month
        # 逐块扫描: 制程 + 计划/达成/达成率 三行一组，年份在列头
        processes = []
        year_span = {}   # col -> (year, month)
        for i in range(3, min(10, len(raw))):
            proc = _s(raw.iloc[i, 1])
            if proc and proc not in processes:
                processes.append(proc)
        # 列 -> (年, 月) 通过第3行(年份) 与第4行(月份)
        year_row = 3
        month_row = 4
        cur_year = None
        for j in range(2, raw.shape[1]):
            y = _s(raw.iloc[year_row, j])
            if y:
                cur_year = y.replace("年", "")
            m_str = _s(raw.iloc[month_row, j])
            if cur_year and m_str and year_row < len(raw):
                month_num = None
                mm = re.search(r"(\d+)月", m_str)
                if mm:
                    month_num = int(mm.group(1))
                if month_num:
                    year_span[j] = (int(cur_year), month_num)

        # 数据行: 制程(第1列) + 计划/达成/达成率 标识(第2列)
        cur_proc = None
        for i in range(3, len(raw)):
            proc = _s(raw.iloc[i, 1])
            if proc:
                cur_proc = proc
            kind = _s(raw.iloc[i, 2])
            if not cur_proc or not kind:
                continue
            if kind not in ("计划", "达成", "达成率"):
                continue
            for j, (yy, mm) in year_span.items():
                v = _num(raw.iloc[i, j])
                if v is None:
                    continue
                result["monthly"].append({
                    "process": cur_proc,
                    "year": yy,
                    "month": mm,
                    "key": f"{yy}-{mm:02d}",
                    "kind": kind,
                    "value": v,
                })

    # ---- By年 sheet ----
    if "By年" in xl.sheet_names:
        raw = xl.parse("By年", header=0)
        cols = [str(c) for c in raw.columns]
        year_cols = []
        for idx, c in enumerate(cols):
            m = re.search(r"(\d{4})年", c)
            if m:
                year_cols.append((idx, int(m.group(1))))
        for i, row in raw.iterrows():
            proc = _s(row.iloc[0])
            plan_kind = _s(row.iloc[2])
            if not proc or not plan_kind:
                continue
            for idx, yy in year_cols:
                v = _num(row.iloc[idx])
                if v is None:
                    continue
                result["by_year"].append({
                    "process": proc,
                    "year": yy,
                    "kind": plan_kind,
                    "value": v,
                })

    # ---- By天 sheet: 计划/投入/产出/结余 按天 ----
    if "By天" in xl.sheet_names:
        raw = xl.parse("By天", header=0)
        cols = [str(c) for c in raw.columns]
        day_cols = {}
        for idx, c in enumerate(cols):
            d = _date_str(c)
            if d:
                day_cols[idx] = d
        # 结构化: 制程|版本|料号|计划类别(计划/投入/产出/结余)
        cur_process = None
        for i, row in raw.iterrows():
            if _s(row.iloc[0]):
                cur_process = _s(row.iloc[0])
            version = _s(row.iloc[1]) or ""
            material = _s(row.iloc[2]) or ""
            kind = _s(row.iloc[3]) or ""
            if not kind:
                continue
            for idx, d in day_cols.items():
                v = _num(row.iloc[idx])
                if v is None:
                    continue
                result["by_day"].append({
                    "process": cur_process or "",
                    "version": version,
                    "material": material,
                    "kind": kind,
                    "date": d,
                    "value": v,
                })

    # 月达成率 sheet 空时的兜底：先用 by_day 计算
    if not result["monthly"] and result["by_day"]:
        print("[warn] 月达成率 sheet 无数据，尝试由 by_day 聚合")
    return result


# ---------------------------------------------------------------------------
# 3. 每日达成记录（日报）
# ---------------------------------------------------------------------------
def parse_daily_shifts(xl_path, is_smt):
    xl = pd.ExcelFile(xl_path)
    records = []
    for sheet_name in xl.sheet_names:
        m = re.search(r"(\d+)\.(\d+)", sheet_name)
        if not m:
            continue
        month, day = int(m.group(1)), int(m.group(2))
        date_key = f"2026-{month:02d}-{day:02d}"
        df = xl.parse(sheet_name, header=0)
        if df.empty:
            continue
        for i, row in df.iterrows():
            if is_smt:
                line = _s(row.iloc[0])        # 线别
                shift = _s(row.iloc[1])       # 班别
                leader = _s(row.iloc[2])
                model = _s(row.iloc[3])
                hr = _num(row.iloc[4])        # 人力
                work_h = _num(row.iloc[5])    # 人力工时
                run_h = _num(row.iloc[6])     # 开机工时
                target = _num(row.iloc[7])    # 目标产出
                semi = _num(row.iloc[8])      # 半成品面
                finish = _num(row.iloc[9])    # 成品面
                diff = _num(row.iloc[10])
                rate = _num(row.iloc[11])
                loss = _s(row.iloc[12])
            else:
                line = _s(row.iloc[0])        # 板测
                process = _s(row.iloc[1])
                shift = _s(row.iloc[2])
                model = _s(row.iloc[3])
                hr = _num(row.iloc[4])
                work_h = _num(row.iloc[5])
                target = _num(row.iloc[6])
                input_qty = _num(row.iloc[7])
                finish = _num(row.iloc[8])
                diff = _num(row.iloc[9])
                rate = _num(row.iloc[10])
                loss = _s(row.iloc[11])
            if not line:
                continue
            # SMT 日报: 跳过 WIP 汇总/空班别行, 制程统一记为 SMT
            if is_smt and (not shift or "WIP" in line.upper()):
                continue
            records.append({
                "date": date_key,
                "line": line,
                "shift": shift or "",
                "leader": leader if is_smt else "",
                "process": "SMT" if is_smt else (process or ""),
                "model": model or "",
                "headcount": hr,
                "work_hours": work_h,
                "run_hours": run_h if is_smt else work_h,
                "target": target,
                "input_qty": input_qty if not is_smt else semi,
                "output_qty": finish,
                "diff": diff,
                "achieve_rate": rate,
                "loss_reason": loss or "",
            })
    return records


def build_daily_records():
    result = {"smt": [], "board_test": []}
    smt_path = os.path.join(DA_CHENG_DIR, "9月份SMT生产日报.xlsx")
    bt_path = os.path.join(DA_CHENG_DIR, "9月份板测生产日报.xlsx")
    if os.path.exists(smt_path):
        print("[read] SMT生产日报")
        result["smt"] = parse_daily_shifts(smt_path, is_smt=True)
    if os.path.exists(bt_path):
        print("[read] 板测生产日报")
        result["board_test"] = parse_daily_shifts(bt_path, is_smt=False)
    return result


# ---------------------------------------------------------------------------
# 4. 主计划 EA / SH (排产甘特输入) + By天达成
# ---------------------------------------------------------------------------
def parse_master_plan(path):
    xl = pd.ExcelFile(path)
    plan = {"source": os.path.basename(path), "ea": [], "sh": []}
    for sheet in ("EA", "SH"):
        if sheet not in xl.sheet_names:
            continue
        df = xl.parse(sheet, header=None)
        # 定位日期行: 行内包含大量 'YYYY-MM-DD' 日期
        date_row_idx = None
        for i in range(min(10, len(df))):
            cnt = sum(1 for v in df.iloc[i].tolist() if _date_str(v))
            if cnt > 10:
                date_row_idx = i
                break
        if date_row_idx is None:
            continue
        col_dates = {}
        for j in range(3, df.shape[1]):
            d = _date_str(df.iloc[date_row_idx, j])
            if d:
                col_dates[j] = d
        data_start = date_row_idx + 1
        for i in range(data_start, len(df)):
            stage = _s(df.iloc[i, 2]) or _s(df.iloc[i, 1]) or _s(df.iloc[i, 0])
            if not stage:
                continue
            version = _s(df.iloc[i, 1]) or ""
            kind = _s(df.iloc[i, 2]) or ""
            items = []
            for j, d in col_dates.items():
                v = _num(df.iloc[i, j])
                if v is not None:
                    items.append({"date": d, "value": v})
            if items:
                plan[sheet.lower()].append({
                    "stage": stage,
                    "version": version or "",
                    "kind": kind or "",
                    "daily": items,
                })
    return plan


def build_plans():
    pattern = os.path.join(DA_CHENG_DIR, "LE0主计划 2026*.xlsx")
    files = glob.glob(pattern)
    latest = None
    for f in files:
        m = re.search(r"(\d{8})", os.path.basename(f))
        key = m.group(1) if m else "0"
        if latest is None or key > latest[0]:
            latest = (key, f)
    if latest:
        print("[read] 主计划:", os.path.basename(latest[1]))
        return parse_master_plan(latest[1])
    return {"ea": [], "sh": []}


# ---------------------------------------------------------------------------
# 5. 排产计划 RU Plan (产能排产/MRP)
# ---------------------------------------------------------------------------
def build_schedule_plan():
    pattern = os.path.join(DA_CHENG_DIR, "LE0主计划排产计划*.xlsx")
    files = glob.glob(pattern)
    latest = None
    for f in files:
        m = re.search(r"(\d{9,10})", os.path.basename(f))
        key = m.group(1) if m else "0"
        if latest is None or key > latest[0]:
            latest = (key, f)
    if latest:
        path = latest[1]
        print("[read] 排产计划:", os.path.basename(path))
    else:
        return {"source": None, "orders": [], "weeks": []}
    xl = pd.ExcelFile(path)
    result = {"source": os.path.basename(path), "orders": [], "weeks": []}
    if "RU Plan" not in xl.sheet_names:
        return result
    df = xl.parse("RU Plan", header=None)
    # 找到主要表头行（序号/版本/软体/...RU加总/排产汇总/GAP）
    header_row_idx = None
    for i in range(0, min(12, len(df))):
        vals = [_s(x) for x in df.iloc[i].tolist()]
        if vals and vals[0] == "序号":
            header_row_idx = i
            break
    if header_row_idx is None:
        return result
    # 周列: 从表头行往上的行找 WK 编号行 和 日期范围行(4/27-5/3)
    wk_row = header_row_idx
    # 日期范围行: 表头行上方,含最多 "M/D-M/D" 的行
    date_range_row = None
    best = 0
    for i in range(header_row_idx - 1, max(-1, header_row_idx - 5), -1):
        vals = [_s(x) for x in df.iloc[i].tolist()]
        cnt = sum(1 for v in vals if v and re.match(r"\d{1,2}/\d{1,2}", v))
        if cnt > best:
            best = cnt
            date_range_row = i
    week_cols = {}
    week_num = {}
    for j in range(header_row_idx + 1, df.shape[1]):
        wk = None
        v = _s(df.iloc[wk_row, j])
        m = re.search(r"(?:WK|wk|周)(\d+)", v or "")
        if m:
            wk = "WK" + m.group(1)
        if not wk:
            continue
        d = None
        if date_range_row is not None:
            dv = _s(df.iloc[date_range_row, j])
            if dv and re.match(r"\d{1,2}/\d{1,2}", dv):
                start = dv.split("-")[0]
                mm, dd = start.split("/")
                d = f"{2026:04d}-{int(mm):02d}-{int(dd):02d}"
        week_cols[j] = d or "2026-01-01"
        week_num[j] = wk

    for i in range(header_row_idx + 1, len(df)):
        seq = _s(df.iloc[i, 0])
        version = _s(df.iloc[i, 1])
        sw_type = _s(df.iloc[i, 3])
        desc = _s(df.iloc[i, 4])
        if not seq:
            continue
        shell = _s(df.iloc[i, 5])
        module = _s(df.iloc[i, 6])
        smt_part = _s(df.iloc[i, 7])
        assy_part = _s(df.iloc[i, 8])
        pack_part = _s(df.iloc[i, 9])
        ru_total = _num(df.iloc[i, 10])
        plan_total = _num(df.iloc[i, 11])
        gap = _num(df.iloc[i, 12])
        weekly = []
        for j, d in week_cols.items():
            v = _num(df.iloc[i, j])
            if v:
                weekly.append({"date": d, "week": week_num.get(j, ""), "qty": v})
        # 排除汇总行/加总行
        if not version:
            continue
        result["orders"].append({
            "seq": seq,
            "version": version,
            "sw_type": sw_type or "",
            "desc": desc or "",
            "shell": shell or "",
            "module": module or "",
            "smt_part": smt_part or "",
            "assy_part": assy_part or "",
            "pack_part": pack_part or "",
            "ru_total": ru_total,
            "plan_total": plan_total,
            "gap": gap,
            "weekly": weekly,
        })
    week_list = [{"date": d, "week": week_num.get(j, "")} for j, d in week_cols.items()]
    result["weeks"] = week_list
    return result


# ---------------------------------------------------------------------------
# 6. 出货计划
# ---------------------------------------------------------------------------
def build_shipping():
    pattern = os.path.join(DA_CHENG_DIR, "LE0出货调整表*.xlsx")
    files = glob.glob(pattern)
    if not files:
        return {"source": None, "shipping": [], "stock": []}
    path = files[0]
    xl = pd.ExcelFile(path)
    result = {"source": os.path.basename(path), "shipping": [], "stock": []}
    if "Shipping" in xl.sheet_names:
        df = xl.parse("Shipping", header=0)
        for i, row in df.iterrows():
            result["shipping"].append({
                "create_date": _date_str(row.iloc[0]),
                "ship_to": _s(row.iloc[1]),
                "mode": _s(row.iloc[2]),
                "pr": _s(row.iloc[3]),
                "po": _s(row.iloc[4]),
                "project": _s(row.iloc[5]),
                "variants": _s(row.iloc[6]),
                "duty": _s(row.iloc[7]),
                "psa_part": _s(row.iloc[8]),
                "fih_part": _s(row.iloc[9]),
                "plan_qty": _num(row.iloc[10]),
                "pickup_week": _s(row.iloc[11]),
                "pickup_date": _date_str(row.iloc[12]),
                "eta": _date_str(row.iloc[13]),
                "eta_week": _s(row.iloc[14]),
                "remark": _s(row.iloc[16]),
            })
    # 库存
    for sheet in ("库存整理表", "0817库存"):
        if sheet in xl.sheet_names:
            df = xl.parse(sheet, header=0)
            cols = [str(c) for c in df.columns]
            if "物料" in cols and "未限制使用的庫存" in cols:
                i_mat = cols.index("物料")
                i_desc = cols.index("物料說明") if "物料說明" in cols else None
                i_stock = cols.index("未限制使用的庫存")
                for _, row in df.iterrows():
                    mat = _s(row.iloc[i_mat])
                    if not mat:
                        continue
                    result["stock"].append({
                        "material": mat,
                        "desc": _s(row.iloc[i_desc]) if i_desc is not None else "",
                        "stock": _num(row.iloc[i_stock]),
                    })
            break
    return result


# ---------------------------------------------------------------------------
# 7. 生产报表（组装/包装按线）
# ---------------------------------------------------------------------------
def build_production_report():
    path = os.path.join(DA_CHENG_DIR, "LE0生产报表最新.xlsx")
    if not os.path.exists(path):
        return {"source": None, "lines": []}
    xl = pd.ExcelFile(path)
    result = {"source": os.path.basename(path), "lines": [{"line": sn, "rows": []} for sn in xl.sheet_names]}
    for line in result["lines"]:
        df = xl.parse(line["line"], header=None)
        for i, row in df.iterrows():
            vals = [_s(x) for x in row.tolist()]
            if any(vals) and i > 0:
                line["rows"].append(vals[:12])
    return result


def main():
    print("=" * 50)
    print("PMC 数据构建开始")
    lines = build_lines()
    write_json("lines.json", lines, compact=True)
    print(f"[ok] lines.json  {len(lines)} 条线体")

    ach = build_monthly_achievement()
    # 前端只加载 monthly / by_year; by_day 体积大, 单独输出到 full/
    light_ach = {"meta": ach.get("meta", {}), "monthly": ach.get("monthly", []), "by_year": ach.get("by_year", [])}
    write_json("achievement.json", light_ach, compact=True)
    write_json("achievement_full.json", ach, compact=True, out_dir=FULL_DIR)
    print(f"[ok] achievement.json  月度{len(light_ach['monthly'])} 年度{len(light_ach['by_year'])} (by_day {len(ach.get('by_day', []))} -> full/)")

    daily = build_daily_records()
    write_json("daily.json", daily, compact=True)
    print(f"[ok] daily.json  SMT {len(daily['smt'])} 板测 {len(daily['board_test'])}")

    plan = build_plans()
    write_json("master_plan.json", plan, compact=True, out_dir=FULL_DIR)
    print(f"[ok] master_plan.json -> full/  EA {len(plan['ea'])} SH {len(plan['sh'])}")

    sched = build_schedule_plan()
    write_json("schedule_plan.json", sched, compact=True)
    print(f"[ok] schedule_plan.json  订单 {len(sched['orders'])} 周 {len(sched['weeks'])}")

    ship = build_shipping()
    write_json("shipping.json", ship, compact=True)
    print(f"[ok] shipping.json  出货 {len(ship['shipping'])} 库存 {len(ship['stock'])}")

    prod = build_production_report()
    write_json("production_report.json", prod, compact=True)
    print(f"[ok] production_report.json")

    # 汇总索引
    index = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source_dir": SRC_ROOT,
        "files": sorted(f for f in os.listdir(OUT_DIR) if f.endswith(".json")),
        "full_files": sorted(os.listdir(FULL_DIR)),
    }
    write_json("_index.json", index, compact=True)
    print("=" * 50)
    print("全部完成！输出目录:", OUT_DIR)


def _sanitize(obj):
    """递归把 NaN / Infinity 转成 None，保证输出合法 JSON。"""
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            return None
        return obj
    try:
        if obj is not None and pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    return obj


def write_json(name, data, compact=False, out_dir=None):
    path = os.path.join(out_dir or OUT_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(_sanitize(data), f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(_sanitize(data), f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()