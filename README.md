# PMC 生产制造管理系统 · LE0

富智康 LE0 线体的生产计划与物料控制（PMC）系统：每日线体达成录入、
计划 vs 实际达成率对比、产能/排产/出货预测、MRP 运算与可视化看板。

## 在线访问（GitHub Pages）

静态站点直接打开 `frontend/index.html` 即可，无需后端：

```
https://zagan2609.github.io/PMC/
```

## 功能模块

| 模块 | 说明 |
| --- | --- |
| 总览看板 | 计划/实际/达成率/缺口 KPI，月度达成趋势、各制程对比、线体 UPH 排行、近 14 日达成 |
| 达成看板 | SMT / 板测生产日报明细（线体×班别）、当日目标/产出/达成率、损失原因、CSV 导出 |
| 产能预测 | 移动平均 / 指数平滑 / 线性回归 / 加权融合，预测未来产能与达成率、预估出货 |
| 排产甘特 | 基于 RU Plan 周排产，按机种版本用 DHTMLX Gantt 展示每周排产 |
| MRP / 排产表 | 毛需求→库存→净需求→建议排产，按线体×周的产能约束排产表 |
| 数据录入 | 浏览器本地录入每日达成（localStorage），后端可用时自动同步到 SQLite |

## 目录结构

```
PMC_sofeware/
├─ frontend/                 # 静态前端（Vue3 + ECharts + DHTMLX Gantt, 全 CDN）
│  ├─ index.html
│  ├─ css/style.css
│  ├─ js/app.js              # 主应用（视图/图表/交互）
│  ├─ js/engines.js          # 预测 / MRP / 排产 运算引擎
│  └─ data/*.json            # 由 build_data.py 从 Excel 生成
├─ backend/                  # 可选增强：FastAPI + SQLite
│  ├─ main.py
│  └─ requirements.txt
└─ tools/
   └─ build_data.py          # Excel → JSON 数据构建脚本
```

## 本地运行

### 静态前端（推荐，零依赖）

```powershell
python -m http.server 8123 --directory frontend
# 浏览器打开 http://127.0.0.1:8123/
```

### 后端增强（数据录入入库 / Python 预测 API）

```powershell
pip install -r backend/requirements.txt
python -m uvicorn main:app --port 8000 --app-dir backend
# 打开 http://127.0.0.1:8000/  （同时托管前端）
```

### 重新生成数据

修改数据源后运行：

```powershell
python tools/build_data.py
# 读取 Excel → 输出到 frontend/data/*.json
```

## 数据源

`D:\BaiduNetdiskDownload\PMC\富智康资料\工作资料\LE0工作資料\LE0工作資料\`

- `LE0 UPH-2026.08.06（EA pro16.6）.xlsx` — 线体 UPH / 日产量
- `達成\LE0 MP 達成記錄*.xlsx` — 月度/年度/逐日达成（计划/投入/产出/差异/WIP/结余）
- `達成\9月份SMT生产日报.xlsx` / `9月份板测生产日报.xlsx` — 日报明细
- `達成\LE0主计划排产计划*.xlsx` — RU Plan 周排产（107 订单 × 28 周）
- `達成\LE0主计划 *.xlsx` — EA / SH 主计划
- `達成\LE0出货调整表*.xlsx` — 出货与库存

## API（后端增强模式）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/data/{name}` | 读取 data 下 JSON |
| GET | `/api/records` | 查询录入记录 |
| POST | `/api/records` | 新增录入记录（自动算达成率/差异） |
| DELETE | `/api/records/{id}` | 删除记录 |
| GET | `/api/forecast` | Python 端产能预测（ma/ema/linreg） |

## 技术栈

- 前端：Vue 3（CDN）、ECharts 5（CDN）、DHTMLX Gantt（CDN）
- 数据构建：Python + pandas + openpyxl
- 后端（可选）：FastAPI + SQLite + uvicorn，可选 Prophet
