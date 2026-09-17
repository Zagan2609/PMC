/* =========================================================
 * app.js — PMC 生产制造管理系统 主应用 (Vue 3)
 * ========================================================= */
const { createApp } = Vue;

const DATA_FILES = {
  lines: 'data/lines.json',
  achievement: 'data/achievement.json',
  daily: 'data/daily.json',
  schedule_plan: 'data/schedule_plan.json',
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
      else if (v === 'gantt') this.buildGantt();
      else if (v === 'mrp') { this.runMRP(); }
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
