/* =========================================================
 * app.js — PMC 生产制造管理系统 主应用 (Vue 3)
 * ========================================================= */
const { createApp } = Vue;

const DATA_FILES = {
  lines: 'data/lines.json',
  achievement: 'data/achievement.json',
  daily: 'data/daily.json',
  schedule_plan: 'data/schedule_plan.json',
  schedule_daily: 'data/schedule_daily.json',
  forecast: 'data/forecast.json',
  gen_schedule: 'data/gen_schedule.json',
  shipping: 'data/shipping.json',
  production_report: 'data/production_report.json',
  _index: 'data/_index.json'
};

const ECHARTS = (el, opt) => {
  if (!el) return null;
  const c = echarts.init(el);
  c.setOption(opt);
  return c;
};

createApp({
  data() {
    return {
      view: 'dashboard',
      tabs: [
        { id: 'dashboard', name: '总览看板', icon: '&#128202;' },
        { id: 'achievement', name: '达成看板', icon: '&#128200;' },
        { id: 'forecast', name: '产能预测', icon: '&#128302;' },
        { id: 'linesched', name: '线体排产表', icon: '&#128203;' },
        { id: 'fcsched', name: '预测排产', icon: '&#128293;' },
        { id: 'gantt', name: '排产甘特', icon: '&#128197;' },
        { id: 'mrp', name: 'MRP / 排产表', icon: '&#128230;' },
        { id: 'entry', name: '数据录入', icon: '&#9997;' }
      ],
      online: false,
      dataVersion: '',
      raw: {
        lines: [],
        achievement: { monthly: [], by_year: [], by_day: [] },
        daily: { smt: [], board_test: [] },
        schedule_plan: { orders: [], weeks: [] },
      schedule_daily: { source: null, records: [] },
      forecast: { lines: [], by_date_total: [], days: 60 },
      gen_schedule: { source: null, records: [] },
        master_plan: { ea: [], sh: [] },
        shipping: { shipping: [], stock: [] },
        production_report: { lines: [] },
        _index: {}
      },

      // achievement view
      achSource: 'smt',
      achDate: '',

      // forecast
      fcProcess: 'ALL',
      fcMethod: 'ma',
      fcPeriods: 5,
      fcResult: null,

      // gantt
      ganttVersion: 'ALL',
      ganttZoom: 'week',
      ganttApi: null,

      // 线体排产表
      lsProcess: 'ALL',
      lsLine: 'ALL',
      lsStart: '',
      lsEnd: '',

      // 预测排产
      fcLine: 'ALL',
      fcScope: 'forecast',
      fcGenProc: 'ALL',

      // mrp
      mrpVersion: 'ALL',
      mrpResult: null,
      schedRows: [],
      schedWeeks: [],

      // entry
      form: { date: '', line: '', shift: '白班', model: '', target: null, output_qty: null, input_qty: null, headcount: null, loss_reason: '' },
      records: [],

      charts: {}
    };
  },

  computed: {
    lines() {
      return (this.raw.lines || []).filter(l => l.line && l.line !== '線體' && l.process && l.process !== '製程');
    },
    achSourceName() { return this.achSource === 'smt' ? 'SMT 生产日报' : '板测生产日报'; },
    dailyList() { return (this.raw.daily && this.raw.daily[this.achSource]) || []; },
    achDates() { return [...new Set(this.dailyList.map(r => r.date))].sort(); },
    achRows() { return this.dailyList.filter(r => r.date === this.achDate); },
    achSummary() {
      let target = 0, output = 0;
      this.achRows.forEach(r => { target += (+r.target || 0); output += (+r.output_qty || 0); });
      return { target, output, diff: output - target, rate: target ? output / target : 0 };
    },
    schedule() { return this.raw.schedule_plan || { orders: [], weeks: [] }; },
    schedule_daily() { return this.raw.schedule_daily || { source: null, records: [] }; },
    forecast() { return this.raw.forecast || { lines: [], by_date_total: [], days: 60, pack_sam_lines: 0, start_date: '', end_date: '' }; },
    gen_schedule() { return this.raw.gen_schedule || { source: null, records: [], weeks: [] }; },

    kpi() {
      const m = (this.raw.achievement && this.raw.achievement.monthly) || [];
      const keys = [...new Set(m.map(r => r.key))].sort();
      const last = keys[keys.length - 1] || '';
      let plan = 0, actual = 0;
      m.filter(r => r.key === last).forEach(r => {
        if (r.process === 'SHIP') return;
        if (r.kind === '计划') plan += (+r.value || 0);
        if (r.kind === '达成') actual += (+r.value || 0);
      });
      return { plan, actual, rate: plan ? actual / plan : 0, gap: actual - plan, monthLabel: last };
    },

    achTrend() { return this.fcSeries(this.achSource); },

    processList() { return ['ALL', 'SMT', 'BLT', 'ASSY', 'PACK', 'SHIP']; },

    fc() {
      return this.fcResult || { avgRate: 0, nextRate: 0, capacity: 0, shipEst: 0, rows: [], shipRows: [] };
    },
    mrp() {
      return this.mrpResult || { rows: [], grossReq: 0, stock: 0, netReq: 0, gap: 0 };
    },

    /* ---- 线体排产表 ---- */
    lsLines() {
      const recs = this.schedule_daily.records || [];
      return [...new Set(recs.map(r => r.line))].sort();
    },
    lsFiltered() {
      const recs = this.schedule_daily.records || [];
      return recs.filter(r =>
        (this.lsProcess === 'ALL' || r.process === this.lsProcess) &&
        (this.lsLine === 'ALL' || r.line === this.lsLine) &&
        (!this.lsStart || r.date >= this.lsStart) &&
        (!this.lsEnd || r.date <= this.lsEnd)
      );
    },
    lsSummary() {
      let qty = 0, byProc = {};
      this.lsFiltered.forEach(r => {
        qty += (+r.qty || 0);
        byProc[r.process] = (byProc[r.process] || 0) + (+r.qty || 0);
      });
      return { count: this.lsFiltered.length, qty, byProc };
    },

    /* ---- 预测排产 ---- */
    fcLines() { return this.forecast.lines || []; },
    fcLineData() {
      if (this.fcLine === 'ALL') {
        // 全厂合计
        const dates = this.fcLines.length ? this.fcLines[0].daily.map(d => d.date) : [];
        return dates.map((date, k) => ({
          date,
          forecast: this.fcLines.reduce((a, l) => a + ((l.daily[k] && l.daily[k].forecast) || 0), 0),
          rest: this.fcLines.every(l => !l.daily[k] || l.daily[k].rest)
        }));
      }
      const l = this.fcLines.find(x => x.line === this.fcLine);
      return l ? l.daily.map(d => ({ date: d.date, forecast: d.forecast, rest: d.rest })) : [];
    },
    fcTotal60() { return this.fcLineData.reduce((a, d) => a + d.forecast, 0); },
    fcWorkDays() { return this.fcLineData.filter(d => !d.rest).length; },
    fcCapacityTotal() {
      if (this.fcLine === 'ALL') return this.fcLines.reduce((a, l) => a + l.daily.filter(d => !d.rest).reduce((s, d) => s + (d.capacity || 0), 0), 0);
      const l = this.fcLines.find(x => x.line === this.fcLine);
      return l ? l.daily.filter(d => !d.rest).reduce((s, d) => s + (d.capacity || 0), 0) : 0;
    },
    fcRulesLines() { return this.fcLines.filter(l => l.uph && l.shift_cap); },
    genRecords() {
      return (this.gen_schedule.records || []).filter(r => this.fcGenProc === 'ALL' || r.process === this.fcGenProc);
    },
    genPivot() {
      // 线体 × 日期 透视 (取前14天)
      const recs = this.genRecords;
      if (!recs.length) return { dates: [], rows: [] };
      const dates = [...new Set(recs.map(r => r.date))].sort().slice(0, 14);
      const lines = [...new Set(recs.map(r => r.line))].sort();
      const map = {};
      recs.forEach(r => {
        const k = r.line + '|' + r.date;
        map[k] = (map[k] || 0) + r.qty;
      });
      return {
        dates,
        rows: lines.map(ln => ({
          line: ln,
          cells: dates.map(d => map[ln + '|' + d] || 0),
          total: dates.reduce((a, d) => a + (map[ln + '|' + d] || 0), 0)
        }))
      };
    },
    genSummary() {
      const byProc = {};
      let qty = 0;
      this.genRecords.forEach(r => { byProc[r.process] = (byProc[r.process] || 0) + r.qty; qty += r.qty; });
      return { count: this.genRecords.length, qty, byProc };
    }
  },

  watch: {
    view(v) { this.$nextTick(() => this.renderView(v)); },
    achDate() { this.$nextTick(() => this.renderAchTrend()); },
    achSource() {
      this.achDate = this.achDates[this.achDates.length - 1] || '';
      this.$nextTick(() => this.renderAchTrend());
    }
  },

  methods: {
    fmt(v) {
      if (v == null || isNaN(v)) return '-';
      return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    },
    rateClass(r) {
      if (r == null) return '';
      if (r >= 1) return 'good';
      if (r >= 0.85) return 'warn';
      return 'bad';
    },
    switchView(v) { this.view = v; },

    async reloadData() {
      this.online = false;
      const entries = Object.entries(DATA_FILES);
      await Promise.all(entries.map(async ([k, url]) => {
        try {
          const res = await fetch(url + '?t=' + Date.now());
          this.raw[k] = await res.json();
        } catch (e) {
          console.warn('加载失败', url, e);
        }
      }));
      this.dataVersion = (this.raw._index && this.raw._index.generated) ? '数据更新于 ' + this.raw._index.generated : '';
      this.online = true;
      this.achDate = this.achDates[this.achDates.length - 1] || '';
      if (this.lines.length && !this.form.line) this.form.line = this.lines[0].line;
      if (!this.form.date) this.form.date = new Date().toISOString().slice(0, 10);
      this.loadRecords();
      this.$nextTick(() => this.renderView(this.view));
    },

    /* ---------- 渲染分发 ---------- */
    renderView(v) {
      if (v === 'dashboard') { this.renderMonthly(); this.renderProcess(); this.renderLine(); this.renderDaily(); }
      else if (v === 'achievement') this.renderAchTrend();
      else if (v === 'forecast') this.runForecast();
      else if (v === 'linesched') this.renderLineSched();
      else if (v === 'fcsched') this.renderFcSched();
      else if (v === 'gantt') this.buildGantt();
      else if (v === 'mrp') { this.runMRP(); }
    },

    /* ---------- 线体排产表 (Excel解析) ---------- */
    renderLineSched() {
      if (!this.lsStart) {
        const recs = this.schedule_daily.records || [];
        if (recs.length) {
          const dates = [...new Set(recs.map(r => r.date))].sort();
          this.lsStart = dates[0];
          this.lsEnd = dates[dates.length - 1];
        }
      }
      this.charts.ls = ECHARTS(this.$refs.chartLsProc, {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: {},
        grid: { left: 70, right: 20, top: 30, bottom: 30 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: Object.keys(this.lsSummary.byProc) },
        series: [{ type: 'bar', name: '排产量', data: Object.values(this.lsSummary.byProc), itemStyle: { color: '#2563eb' }, label: { show: true, position: 'right' } }]
      });
    },

    /* ---------- 预测排产 ---------- */
    renderFcSched() {
      const data = this.fcLineData;
      const wkLabels = data.map(d => d.date.slice(5));
      this.charts.fcs = ECHARTS(this.$refs.chartFcSched, {
        tooltip: { trigger: 'axis' },
        grid: { left: 70, right: 30, top: 30, bottom: 30 },
        xAxis: { type: 'category', data: wkLabels },
        yAxis: { type: 'value', name: this.fcLine === 'ALL' ? '全厂合计' : this.fcLine },
        series: [
          { name: '预测达成', type: 'line', data: data.map(d => d.forecast), smooth: true, areaStyle: { opacity: .12 }, itemStyle: { color: '#2563eb' }, lineStyle: { width: 2.5 } },
          { name: '休息日', type: 'bar', data: data.map(d => d.rest ? 0 : null), markArea: { itemStyle: { color: 'rgba(220,38,38,.08)' }, data: [{ xAxis: -1 }, { xAxis: -1 }] } }
        ]
      });
    },

    /* ---------- 日报序列 ---------- */
    fcSeries(source) {
      const list = (this.raw.daily && this.raw.daily[source]) || [];
      const map = {};
      list.forEach(r => {
        const k = r.date;
        if (!map[k]) map[k] = { date: k, target: 0, output: 0 };
        map[k].target += (+r.target || 0);
        map[k].output += (+r.output_qty || 0);
      });
      return Object.values(map).sort((a, b) => a.date < b.date ? -1 : 1);
    },

    /* ---------- 总览图表 ---------- */
    renderMonthly() {
      const m = (this.raw.achievement && this.raw.achievement.monthly) || [];
      const keys = [...new Set(m.map(r => r.key))].sort().slice(-14);
      const plan = keys.map(k => m.filter(r => r.key === k && r.kind === '计划' && r.process !== 'SHIP').reduce((a, r) => a + (+r.value || 0), 0));
      const act = keys.map(k => m.filter(r => r.key === k && r.kind === '达成' && r.process !== 'SHIP').reduce((a, r) => a + (+r.value || 0), 0));
      const rate = keys.map((k, i) => plan[i] ? +(act[i] / plan[i] * 100).toFixed(1) : 0);
      this.charts.monthly = ECHARTS(this.$refs.chartMonthly, {
        tooltip: { trigger: 'axis' },
        legend: { data: ['计划', '达成', '达成率'] },
        grid: { left: 60, right: 50, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: keys },
        yAxis: [
          { type: 'value', name: '数量' },
          { type: 'value', name: '达成率%', max: 120, axisLabel: { formatter: '{value}%' } }
        ],
        series: [
          { name: '计划', type: 'bar', data: plan, itemStyle: { color: '#93c5fd' } },
          { name: '达成', type: 'bar', data: act, itemStyle: { color: '#2563eb' } },
          { name: '达成率', type: 'line', yAxisIndex: 1, data: rate, smooth: true, itemStyle: { color: '#f59e0b' }, lineStyle: { width: 3 } }
        ]
      });
    },

    renderProcess() {
      const y = (this.raw.achievement && this.raw.achievement.by_year) || [];
      const years = [...new Set(y.map(r => r.year))].sort().slice(-4);
      const procs = [...new Set(y.map(r => r.process))].filter(p => p !== 'SHIP');
      const series = procs.map(p => ({
        name: p, type: 'bar', stack: 'total',
        data: years.map(yr => y.filter(r => r.process === p && r.year === yr && /产出|达成|Output/.test(r.kind)).reduce((a, r) => a + (+r.value || 0), 0))
      }));
      this.charts.process = ECHARTS(this.$refs.chartProcess, {
        tooltip: { trigger: 'axis' },
        legend: {},
        grid: { left: 60, right: 20, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: years.map(v => v + '年') },
        yAxis: { type: 'value' },
        series
      });
    },

    renderLine() {
      const ls = this.lines.filter(l => (+l.daily_output || 0) > 0).sort((a, b) => (+b.daily_output) - (+a.daily_output)).slice(0, 15);
      this.charts.line = ECHARTS(this.$refs.chartLine, {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 110, right: 30, top: 20, bottom: 30 },
        xAxis: { type: 'value' },
        yAxis: { type: 'category', data: ls.map(l => l.line).reverse() },
        series: [{
          type: 'bar', data: ls.map(l => +l.daily_output).reverse(),
          itemStyle: { color: p => ['#2563eb', '#0ea5e9', '#06b6d4', '#14b8a6', '#22c55e', '#84cc16'][p.dataIndex % 6] },
          label: { show: true, position: 'right', formatter: '{c}' }
        }]
      });
    },

    renderDaily() {
      const tr = this.fcSeries(this.achSource).slice(-14);
      this.charts.daily = ECHARTS(this.$refs.chartDaily, {
        tooltip: { trigger: 'axis' },
        legend: { data: ['目标', '产出', '达成率'] },
        grid: { left: 60, right: 50, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: tr.map(r => r.date.slice(5)) },
        yAxis: [{ type: 'value' }, { type: 'value', max: 120, axisLabel: { formatter: '{value}%' } }],
        series: [
          { name: '目标', type: 'line', data: tr.map(r => r.target), itemStyle: { color: '#94a3b8' }, linestyle: { type: 'dashed' } },
          { name: '产出', type: 'bar', data: tr.map(r => r.output), itemStyle: { color: '#3b82f6' } },
          { name: '达成率', type: 'line', yAxisIndex: 1, data: tr.map(r => r.target ? +(r.output / r.target * 100).toFixed(1) : 0), itemStyle: { color: '#f59e0b' } }
        ]
      });
    },

    /* ---------- 达成看板 ---------- */
    renderAchTrend() {
      const tr = this.fcSeries(this.achSource);
      this.charts.achTrend = ECHARTS(this.$refs.chartAchTrend, {
        tooltip: { trigger: 'axis' },
        legend: { data: ['目标', '产出', '达成率'] },
        grid: { left: 60, right: 50, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: tr.map(r => r.date.slice(5)) },
        yAxis: [{ type: 'value' }, { type: 'value', max: 130, axisLabel: { formatter: '{value}%' } }],
        series: [
          { name: '目标', type: 'line', data: tr.map(r => r.target), itemStyle: { color: '#94a3b8' } },
          { name: '产出', type: 'line', data: tr.map(r => r.output), itemStyle: { color: '#2563eb' }, areaStyle: { opacity: .15 } },
          { name: '达成率', type: 'line', yAxisIndex: 1, data: tr.map(r => r.target ? +(r.output / r.target * 100).toFixed(1) : 0), itemStyle: { color: '#f59e0b' }, smooth: true }
        ]
      });
    },

    /* ---------- 产能预测 ---------- */
    runForecast() {
      const daily = [];
      Object.values(this.raw.daily || {}).forEach(list => (list || []).forEach(r => daily.push(r)));
      const E = window.PMCEngine;
      const f = E.Forecast.build(daily, this.fcProcess, this.fcMethod, this.fcPeriods);
      f.shipRows = E.Forecast.shipRows(this.raw.production_report, daily);
      this.fcResult = f;

      const raw = f.raw;
      const labels = raw.map(r => r.date.slice(5));
      const futLabels = f.rows.map(r => r.label.slice(5));
      const lastDate = raw.length ? E.parseDate(raw[raw.length - 1].date) : new Date();
      for (let i = 0; i < f.rows.length; i++) futLabels[i] = E.fmtDate(E.addDays(lastDate, i + 1));

      this.charts.forecast = ECHARTS(this.$refs.chartForecast, {
        tooltip: { trigger: 'axis' },
        legend: { data: ['实际产出', '平滑趋势', '预测产出'] },
        grid: { left: 60, right: 30, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: labels.concat(futLabels) },
        yAxis: { type: 'value' },
        series: [
          { name: '实际产出', type: 'line', data: raw.map(r => r.output), itemStyle: { color: '#cbd5e1' }, lineStyle: { width: 1 }, showSymbol: false },
          { name: '平滑趋势', type: 'line', data: f.history, smooth: true, itemStyle: { color: '#2563eb' }, lineStyle: { width: 3 }, showSymbol: false },
          { name: '预测产出', type: 'line', data: labels.map(() => null).concat(f.predict), itemStyle: { color: '#dc2626' }, lineStyle: { type: 'dashed', width: 3 } }
        ]
      });
      this.renderShip(f.shipRows);
    },

    renderShip(rows) {
      // 出货表由模板渲染, 无需图表; 保留接口
    },

    /* ---------- 甘特图 ---------- */
    buildGantt() {
      if (!window.gantt || !this.$refs.ganttBox) return;
      const g = window.gantt;
      try {
        if (!g.$container) {
          g.config.date_format = '%Y-%m-%d';
          g.config.row_height = 26;
          g.config.bar_height = 18;
          g.config.open_tree_initially = true;
          if (g.i18n && g.i18n.setLocale) { try { g.i18n.setLocale('cn'); } catch (e) {} }
          g.init(this.$refs.ganttBox);
        } else {
          g.clearAll();
        }
      } catch (e) {
        try { g.init(this.$refs.ganttBox); } catch (e2) { console.warn('gantt init', e2); return; }
      }

      const orders = this.schedule.orders.filter(o => this.ganttVersion === 'ALL' || o.version === this.ganttVersion);
      const tasks = { data: [], links: [] };
      let id = 1;
      orders.forEach(o => {
        const withQty = (o.weekly || []).filter(w => +w.qty > 0);
        const total = withQty.reduce((a, w) => a + (+w.qty || 0), 0);
        if (!withQty.length && total <= 0) return;
        const parent = id++;
        tasks.data.push({
          id: parent,
          text: `[${o.version}] ${o.sw_type || ''} ${o.desc || ''}`.slice(0, 42),
          start_date: withQty.length ? withQty[0].date : (this.schedule.weeks[0] && this.schedule.weeks[0].date) || '2026-04-27',
          duration: 1, type: 'project', open: true, color: '#1e3a8a'
        });
        withQty.forEach(w => {
          tasks.data.push({
            id: id++, text: `${w.week} · ${this.fmt(w.qty)}`,
            start_date: w.date || '2026-04-27', duration: 6,
            parent: parent, progress: 0.4,
            color: o.version === 'SH' ? '#0ea5e9' : '#3b82f6'
          });
        });
      });
      g.parse(tasks);
      this.ganttApi = g;
      this.applyZoom();
    },

    applyZoom() {
      if (!this.ganttApi) return;
      const g = this.ganttApi;
      const top = this.ganttZoom === 'day' ? 'day' : this.ganttZoom === 'month' ? 'month' : 'week';
      g.config.scales = [
        { unit: top, step: 1, format: top === 'month' ? '%Y-%m' : (top === 'week' ? 'WK%W %Y' : '%Y-%m-%d') },
        { unit: 'day', step: 1, format: '%d' }
      ];
      try { g.render(); } catch (e) {}
    },

    rebuildGantt() { this.buildGantt(); },

    /* ---------- MRP ---------- */
    runMRP() {
      const E = window.PMCEngine;
      const inv = (this.raw.shipping && this.raw.shipping.stock) || [];
      const orders = this.schedule.orders || [];
      this.mrpResult = E.MRP.run(orders, inv, this.mrpVersion);
      const sched = E.Scheduler.run(this.lines, orders, this.schedule.weeks, 20);
      this.schedRows = sched.rows;
      this.schedWeeks = (this.schedule.weeks || []).slice(0, 12).map(w => w.week);
    },

    exportMRP() {
      const header = ['版本', '料号(SMT)', 'ASSY', 'PACK', '需求', '库存', '净需求', '建议排产'];
      const lines = [header.join(',')];
      this.mrp.rows.forEach(r => lines.push([r.version, r.smt_part, r.assy_part, r.pack_part, r.demand, r.stock, r.net, r.schedule].join(',')));
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      this.download(blob, 'MRP_排产表.csv');
    },

    exportCSV() {
      const cols = ['date', 'line', 'shift', 'process', 'model', 'headcount', 'target', 'input_qty', 'output_qty', 'diff', 'achieve_rate', 'loss_reason'];
      const lines = [cols.join(',')];
      this.achRows.forEach(r => lines.push(cols.map(c => `"${r[c] == null ? '' : r[c]}"`).join(',')));
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      this.download(blob, `${this.achSource}_${this.achDate}.csv`);
    },

    download(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    },

    /* ---------- 通用导出 ---------- */
    csvBlob(rows) {
      return new Blob(['\ufeff' + rows.map(r => r.map(c => `"${c == null ? '' : c}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    },
    xlsBlob(sheetName, rows) {
      const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1">${rows.map((r, i) => '<tr>' + r.map(c => `<${i === 0 ? 'th' : 'td'} style="${i === 0 ? 'background:#dbeafe;font-weight:bold' : ''}">${c == null ? '' : c}</${i === 0 ? 'th' : 'td'}>`).join('') + '</tr>').join('')}</table></body></html>`;
      return new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    },
    exportBoth(base, rows) {
      this.download(this.csvBlob(rows), base + '.csv');
      setTimeout(() => this.download(this.xlsBlob(base, rows), base + '.xls'), 300);
    },
    exportLineSched() {
      const rows = [['日期', '星期', '班别', '线体', '制程', '区域', '机种/料号', '工单批量', '版本', 'SAP/BLT/Fmes工单', '当班排配数量', '标准人力', '排配工时', '数据来源']];
      const wd = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      this.lsFiltered.forEach(r => rows.push([r.date, wd[new Date(r.date).getDay() === 0 ? 6 : new Date(r.date).getDay() - 1] || '', r.shift, r.line, r.process, r.area, r.model, r.batch, r.version, r.wo, r.qty, r.manpower, r.hours, this.schedule_daily.source]));
      this.exportBoth('LE0线体排产表', rows);
    },
    exportForecast() {
      const rows = [['线体', '制程', 'UPH', '日产能(UPH基准)', '近21天日均', '达成率', '日期', '星期', '工作/休息', '星期系数', '预测达成量']];
      const wd = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      const lines = this.fcLine === 'ALL' ? this.fcLines : this.fcLines.filter(l => l.line === this.fcLine);
      lines.forEach(l => l.daily.forEach(d => rows.push([l.line, l.process, l.uph, l.capacity_daily, Math.round(l.base_daily), (l.rate * 100).toFixed(1) + '%', d.date, wd[d.weekday], d.rest ? '休息' : '工作', d.factor, d.forecast])));
      this.exportBoth('LE0线体60天预测', rows);
    },
    exportGenSched() {
      const rows = [['日期', '周别', '星期', '线体', '制程', '版本', '机种/料号', '说明', '建议排产量', '换线', '计划工单', 'PACK三星线数']];
      const wd = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      this.genRecords.forEach(r => {
        const w = new Date(r.date).getDay();
        rows.push([r.date, r.week, wd[w === 0 ? 6 : w - 1], r.line, r.process, r.version, r.model, r.desc, r.qty, r.co ? '换线' : '', r.wo, r.pack_sam_lines != null ? r.pack_sam_lines : '']);
      });
      this.exportBoth('LE0自动排产表', rows);
    },
    exportForecastRules() {
      const rows = [['线体', '制程', '楼层', '版本', 'UPH', '班产能(11.5h)', '工时损耗说明', '近21天日均', '换线频率(次/周)']];
      this.fcRulesLines.forEach(l => rows.push([l.line, l.process, l.floor, l.version || '不限', l.uph, l.shift_cap, l.note, Math.round(l.base_daily), l.co_per_week]));
      this.exportBoth('LE0_UPH标准工时', rows);
    },
    exportMasterSchedule() {
      const rows = [['序号', '版本', '软体', '说明', '壳料', '模组', 'SMT料号', 'ASSY料号', 'PACK料号', 'RU加总', '排产汇总', 'GAP']];
      this.schedule.orders.forEach(o => rows.push([o.seq, o.version, o.sw_type, o.desc, o.shell, o.module, o.smt_part, o.assy_part, o.pack_part, o.ru_total, o.plan_total, o.gap]));
      this.exportBoth('LE0主计划排产计划_RU_Plan', rows);
    },

    /* ---------- 数据录入 ---------- */
    loadRecords() {
      try { this.records = JSON.parse(localStorage.getItem('pmc_records') || '[]'); } catch (e) { this.records = []; }
    },
    saveRecords() { localStorage.setItem('pmc_records', JSON.stringify(this.records)); },
    addRecord() {
      const r = { ...this.form };
      r.achieve_rate = r.target ? +((r.output_qty || 0) / r.target).toFixed(4) : null;
      r.diff = (r.output_qty || 0) - (r.target || 0);
      this.records.unshift(r);
      this.saveRecords();
      // 后端可用时同步到数据库, 失败静默降级为本地
      fetch('/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r)
      }).then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(j => alert('已保存到后端数据库 (id=' + j.id + ')'))
        .catch(() => alert('已保存记录（浏览器本地）'));
    },
    delRecord(i) { this.records.splice(i, 1); this.saveRecords(); },
    exportRecords() {
      const blob = new Blob([JSON.stringify(this.records, null, 2)], { type: 'application/json' });
      this.download(blob, 'records.json');
    }
  },

  mounted() {
    window.addEventListener('resize', () => {
      Object.values(this.charts).forEach(c => c && c.resize && c.resize());
    });
    this.reloadData();
  }
}).mount('#app');
