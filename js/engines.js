/* =========================================================
 * engines.js — 前端运算引擎
 *   产能预测 (Forecast) / MRP / 产能约束排产 (Scheduler)
 * 纯浏览器端运算，无需后端。
 * ========================================================= */
(function (global) {
  'use strict';

  /* ---------------- 数值工具 ---------------- */
  function n(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  /* ---------------- 时间工具 ---------------- */
  function parseDate(s) {
    if (!s) return null;
    var d = new Date(String(s).replace(/\//g, '-'));
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(d) {
    var y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + dd;
  }
  function addDays(d, k) { var x = new Date(d); x.setDate(x.getDate() + k); return x; }
  function addWeeks(d, k) { return addDays(d, k * 7); }

  /* =========================================================
   * 1. 产能预测
   * ========================================================= */
  var Forecast = {
    /**
     * 从日报明细中按日期聚合出某制程的日产出序列
     * @param {Array} dailyRecords  daily.json records [{date, process, output, target, rate}]
     * @param {string} process      制程 (ALL 表示全部)
     * @returns {Array} [{date, output, target, rate}]
     */
    series: function (dailyRecords, process) {
      var map = {};
      (dailyRecords || []).forEach(function (r) {
        if (process && process !== 'ALL' && r.process !== process) return;
        var key = r.date;
        if (!map[key]) map[key] = { date: key, output: 0, target: 0 };
        map[key].output += n(r.output_qty != null ? r.output_qty : r.output);
        map[key].target += n(r.target);
      });
      var arr = Object.keys(map).sort().map(function (k) {
        var o = map[k];
        o.rate = o.target > 0 ? o.output / o.target : null;
        return o;
      });
      return arr;
    },

    ma: function (values, window) {
      window = window || 3;
      var out = [];
      for (var i = 0; i < values.length; i++) {
        var s = Math.max(0, i - window + 1), seg = values.slice(s, i + 1);
        out.push(seg.reduce(function (a, b) { return a + b; }, 0) / seg.length);
      }
      return out;
    },

    ema: function (values, alpha) {
      alpha = alpha || 0.35;
      var out = [], prev = values.length ? values[0] : 0;
      for (var i = 0; i < values.length; i++) {
        prev = i === 0 ? values[0] : alpha * values[i] + (1 - alpha) * prev;
        out.push(prev);
      }
      return out;
    },

    linreg: function (values) {
      var k = values.length;
      if (k === 0) return { slope: 0, intercept: 0, fit: [] };
      var sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (var i = 0; i < k; i++) { sx += i; sy += values[i]; sxy += i * values[i]; sxx += i * i; }
      var denom = k * sxx - sx * sx;
      var slope = denom === 0 ? 0 : (k * sxy - sx * sy) / denom;
      var intercept = (sy - slope * sx) / k;
      var fit = values.map(function (_, i) { return intercept + slope * i; });
      return { slope: slope, intercept: intercept, fit: fit };
    },

    /**
     * 选定方法对序列做平滑 + 向后外推
     * @returns {{history:Array, predict:Array, method:string}}
     */
    run: function (values, method, periods) {
      periods = periods || 3;
      var base;
      if (method === 'linreg') base = this.linreg(values).fit;
      else if (method === 'ema') base = this.ema(values, 0.35);
      else if (method === 'blend') {
        var a = this.ma(values, 3), b = this.ema(values, 0.35);
        base = values.map(function (_, i) { return 0.5 * a[i] + 0.5 * b[i]; });
      } else base = this.ma(values, 3);

      var predict = [];
      if (method === 'linreg') {
        var lr = this.linreg(values);
        for (var i = 1; i <= periods; i++) predict.push(lr.intercept + lr.slope * (values.length - 1 + i));
      } else {
        var last = base.length ? base[base.length - 1] : 0;
        for (var j = 0; j < periods; j++) predict.push(last);
      }
      return { history: base, predict: predict, method: method };
    },

    /**
     * 主入口: 给出预测矩阵
     */
    build: function (dailyRecords, process, method, periods) {
      var raw = this.series(dailyRecords, process);
      var outputs = raw.map(function (r) { return r.output; });
      var targets = raw.map(function (r) { return r.target; });
      var rates = raw.map(function (r) { return r.rate == null ? 0 : r.rate; });

      var outRun = this.run(outputs, method, periods);
      var rateRun = this.run(rates, method, periods);

      var avgRate = rates.length ? rates.reduce(function (a, b) { return a + b; }, 0) / rates.length : 0;
      var nextRate = rateRun.predict.length ? rateRun.predict[rateRun.predict.length - 1] : avgRate;
      if (nextRate > 1.15) nextRate = 1.15;
      if (nextRate < 0) nextRate = 0;

      // 未来需求按最近目标均值外推
      var recentTargets = targets.slice(-7);
      var avgTarget = recentTargets.length ? recentTargets.reduce(function (a, b) { return a + b; }, 0) / recentTargets.length : 0;

      var rows = [], lastDate = raw.length ? parseDate(raw[raw.length - 1].date) : new Date();
      for (var i = 0; i < periods; i++) {
        var demand = avgTarget * (1 + 0.03 * i);
        var capacity = outRun.predict[i] || avgTarget;
        var rate = demand > 0 ? capacity / demand : 0;
        rows.push({
          label: lastDate ? fmtDate(addDays(lastDate, (i + 1))) : ('P' + (i + 1)),
          demand: Math.round(demand),
          capacity: Math.round(capacity),
          rate: rate
        });
      }

      return {
        raw: raw,
        history: outRun.history,
        predict: outRun.predict,
        rates: rates,
        ratePredict: rateRun.predict,
        avgRate: avgRate,
        nextRate: nextRate,
        capacity: Math.round(outRun.predict.length ? outRun.predict[outRun.predict.length - 1] : avgTarget),
        shipEst: Math.round((outRun.predict.reduce(function (a, b) { return a + b; }, 0))),
        rows: rows
      };
    },

    /**
     * 预估出货: 按制程统计库存 + 未来产出
     */
    shipRows: function (productionReport, dailyRecords) {
      var stock = {}, output = {};
      var inv = (productionReport && (productionReport.inventory || productionReport.shipment)) || [];
      inv.forEach(function (r) {
        var p = r.process || r.制程 || '未分类';
        stock[p] = n(stock[p]) + n(r.qty || r.数量 || r.stock);
      });
      (dailyRecords || []).forEach(function (r) {
        var p = r.process || '未分类';
        output[p] = n(output[p]) + n(r.output_qty != null ? r.output_qty : r.output);
      });
      var keys = Object.keys(Object.assign({}, stock, output));
      return keys.map(function (p) {
        var s = n(stock[p]), o = n(output[p]);
        return { process: p, stock: s, output: o, ship: s + o };
      });
    }
  };

  /* =========================================================
   * 2. MRP 物料需求计划
   * ========================================================= */
  var MRP = {
    /**
     * @param {Array} orders     schedule_plan.orders
     * @param {Array} inventory  shipping/inventory [{process/part, qty}]
     * @param {string} version   过滤 ALL/EA/SH
     */
    run: function (orders, inventory, version) {
      var stockMap = {};
      (inventory || []).forEach(function (r) {
        var key = String(r.part || r.料号 || r.model || r.process || '').trim();
        if (key) stockMap[key] = n(stockMap[key]) + n(r.qty || r.stock || r.库存);
      });

      var rows = [];
      var grossReq = 0, stockTotal = 0, netTotal = 0;

      (orders || []).forEach(function (o) {
        if (version && version !== 'ALL' && o.version !== version) return;
        var demand = n(o.total) || (o.weekly || []).reduce(function (a, w) { return a + n(w.qty); }, 0);
        if (demand <= 0) return;
        var stock = n(stockMap[o.smt_part]) || n(stockMap[o.assy_part]) || n(stockMap[o.version]);
        var net = Math.max(0, demand - stock);
        grossReq += demand; stockTotal += Math.min(stock, demand); netTotal += net;
        rows.push({
          version: o.version || '',
          smt_part: o.smt_part || '',
          assy_part: o.assy_part || '',
          pack_part: o.pack_part || '',
          shell: o.shell || '',
          module: o.module || '',
          demand: demand,
          stock: stock,
          net: net,
          schedule: net
        });
      });

      return {
        rows: rows,
        grossReq: grossReq,
        stock: stockTotal,
        netReq: netTotal,
        gap: rows.reduce(function (a, r) { return a + r.net; }, 0)
      };
    }
  };

  /* =========================================================
   * 3. 产能约束排产 Scheduler
   * ========================================================= */
  var Scheduler = {
    /**
     * 按线体产能(UPH×工作小时)把需求分配到周
     * @param {Array} lines      lines.json
     * @param {Array} orders     schedule_plan.orders (含 weekly)
     * @param {number} hoursPerDay  每日有效工作小时 (默认 20)
     * @param {Array} weeks      schedule_plan.weeks
     */
    run: function (lines, orders, weeks, hoursPerDay) {
      hoursPerDay = hoursPerDay || 20;
      // 每周产能 = 日产量 × 6 天
      var lineCap = {};
      (lines || []).forEach(function (l) {
        lineCap[l.line] = {
          line: l.line,
          process: l.process,
          weeklyCap: n(l.daily_output) * 6
        };
      });

      // 收集每周需求
      var weekKeys = (weeks || []).map(function (w) { return w.week; });
      var demandByWeek = {};
      weekKeys.forEach(function (wk) { demandByWeek[wk] = 0; });
      (orders || []).forEach(function (o) {
        (o.weekly || []).forEach(function (w) {
          if (demandByWeek[w.week] == null) demandByWeek[w.week] = 0;
          demandByWeek[w.week] += n(w.qty);
        });
      });

      // 按制程分组线体容量 (ASSY 前段/老化/後段 统一归入 ASSY)
      var procLines = {};
      Object.keys(lineCap).forEach(function (k) {
        var lc = lineCap[k];
        var p = lc.process === 'ASSY前段' || lc.process === 'ASSY老化' || lc.process === 'ASSY後段' ? 'ASSY' : lc.process;
        (procLines[p] = procLines[p] || []).push(lc);
      });

      // 简单分配: 需求按制程可用线体循环填充
      var rows = [];
      var procs = ['SMT', 'BLT', 'ASSY', 'PACK'];
      procs.forEach(function (proc) {
        var ls = procLines[proc] || [];
        var totalCap = ls.reduce(function (a, b) { return a + b.weeklyCap; }, 0);
        if (!ls.length) return;
        var row = { line: proc + ' 合计', process: proc, weeks: {}, total: 0 };
        var rowAll = { line: '', process: proc, weeks: {}, total: 0, _detail: true };
        weekKeys.forEach(function (wk) {
          var demand = demandByWeek[wk] || 0;
          // 平均摊到每条线，不超单线产能
          var perLine = ls.length ? demand / ls.length : 0;
          var assign = Math.min(perLine, ls.length ? ls[0].weeklyCap : 0) * ls.length;
          row.weeks[wk] = Math.round(assign || Math.min(demand, totalCap));
          row.total += row.weeks[wk];
        });
        rows.push({ line: proc + ' 产能', process: proc, weeks: wkTotals(row.weeks, Math.round(totalCap / Math.max(1, weekKeys.length))), total: row.total });
      });

      // 每条线单独一行
      var detailed = [];
      procs.forEach(function (proc) {
        var ls = procLines[proc] || [];
        ls.forEach(function (l, idx) {
          var row = { line: l.line, process: proc, weeks: {}, total: 0 };
          weekKeys.forEach(function (wk) {
            var demand = demandByWeek[wk] || 0;
            var perLine = ls.length ? Math.min(demand / ls.length, l.weeklyCap) : 0;
            var v = Math.round(perLine);
            row.weeks[wk] = v;
            row.total += v;
          });
          detailed.push(row);
        });
      });

      return { rows: detailed.length ? detailed : rows, weekKeys: weekKeys.slice(0, 12) };
    }
  };

  function wkTotals(weeks, cap) {
    var o = {};
    Object.keys(weeks).forEach(function (k) { o[k] = Math.min(weeks[k], cap); });
    return o;
  }

  global.PMCEngine = { Forecast: Forecast, MRP: MRP, Scheduler: Scheduler, parseDate: parseDate, fmtDate: fmtDate, addDays: addDays, addWeeks: addWeeks };
})(window);
