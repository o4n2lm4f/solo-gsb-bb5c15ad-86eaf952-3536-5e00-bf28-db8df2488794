/* 复盘播放清单测试：虚拟时间轴拼接（不合并、保序、累计区间时长）、
 * 虚拟时刻 → 原始时刻映射（边界进入后一段、末尾钳制、零长段跳过）、
 * 倍速按累计时长映射、重叠区间分别播放，以及页面只读性。
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 * 映射算法直接加载 public/playlist.js（与浏览器同一份代码）；
 * HTTP 部分断言页面可访问且不含 WebSocket / 写接口调用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 加载浏览器版 public/playlist.js（纯函数，无浏览器依赖）
function loadBrowserPlaylist() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'playlist.js'), 'utf8');
  const withoutExport = src.replace(/\nif \(typeof module[\s\S]*$/, '');
  const fn = new Function(withoutExport.replace('const CuePlaylist = (() => {', 'return (() => {'));
  return fn();
}

const SESSION_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

// 构造清单条目：key / 场次 / 原始区间
function seg(key, fileId, startT, endT) {
  return { key, fileId, runId: 0, startT, endT };
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

async function main() {
  const P = loadBrowserPlaylist();

  console.log('一、虚拟时间轴拼接：按清单顺序、累计区间时长、绝不合并');
  // 三段：A 场 10s→50s（40s），B 场 20s→30s（10s，与 A 原始时刻无关），A 场 40s→45s（5s，与第一段原始区间重叠）
  const items = [
    seg('k1', SESSION_A, 10000, 50000),
    seg('k2', SESSION_B, 20000, 30000),
    seg('k3', SESSION_A, 40000, 45000), // 与 k1 原始区间 [10s,50s] 重叠：必须分别成段
  ];
  const tl = P.buildTimeline(items);
  check('段数与清单一致（重叠区间不合并）', tl.segments.length === 3);
  check('各段保持清单顺序', tl.segments[0].key === 'k1' && tl.segments[1].key === 'k2' && tl.segments[2].key === 'k3');
  check('各段时长为区间时长', tl.segments[0].duration === 40000 && tl.segments[1].duration === 10000 && tl.segments[2].duration === 5000);
  check('虚拟起点按累计时长拼接', tl.segments[0].vStart === 0 && tl.segments[1].vStart === 40000 && tl.segments[2].vStart === 50000);
  check('虚拟总时长为各段累计', tl.total === 55000 && tl.segments[2].vEnd === 55000);
  check('负时长区间按 0 计', P.buildTimeline([seg('x', SESSION_A, 5000, 3000)]).total === 0);
  check('空清单得到空时间轴', P.buildTimeline([]).segments.length === 0 && P.buildTimeline([]).total === 0);

  console.log('二、虚拟时刻 → 原始时刻映射：按累计区间时长映射到对应场次');
  check('v=0 → 第一段起点', P.locate(tl, 0).t === 10000 && P.locate(tl, 0).index === 0);
  check('段内线性映射：v=25s → k1 的 10s+25s=35s', P.locate(tl, 25000).t === 35000 && P.locate(tl, 25000).index === 0);
  check('跨场次：v=40.5s → 第二段（B 场）起点 +0.5s', (() => {
    const l = P.locate(tl, 40500);
    return l.index === 1 && l.segment.fileId === SESSION_B && l.t === 20500;
  })());
  check('v 恰好等于段边界 → 进入后一段起点', (() => {
    const l = P.locate(tl, 40000);
    return l.index === 1 && l.t === 20000 && l.atEnd === false;
  })());
  check('v 恰好等于第二段边界 → 进入第三段起点', (() => {
    const l = P.locate(tl, 50000);
    return l.index === 2 && l.t === 40000;
  })());
  check('v=total（末尾）→ 钳制到最后一段终点', (() => {
    const l = P.locate(tl, 55000);
    return l.index === 2 && l.t === 45000 && l.atEnd === true;
  })());
  check('v 超出末尾 → 同样钳制到最后一段终点', P.locate(tl, 999999).t === 45000 && P.locate(tl, 999999).atEnd === true);
  check('v 为负 → 钳制到 0（第一段起点）', P.locate(tl, -100).t === 10000 && P.locate(tl, -100).index === 0);
  check('空时间轴定位返回 null', P.locate(P.buildTimeline([]), 0) === null);

  console.log('三、零长区间：不占虚拟时间轴，边界规则下自然越过');
  const zeroTl = P.buildTimeline([
    seg('z1', SESSION_A, 1000, 5000), // 4s
    seg('z2', SESSION_A, 7000, 7000), // 零长
    seg('z3', SESSION_A, 9000, 11000), // 2s
  ]);
  check('零长段时长为 0、不改变后续段虚拟起点', zeroTl.segments[1].duration === 0 && zeroTl.segments[2].vStart === 4000);
  check('落在零长段位置 → 进入后一段（零长段不可见）', (() => {
    const l = P.locate(zeroTl, 4000);
    return l.index === 2 && l.t === 9000;
  })());
  check('全部零长 → 末尾钳制到最后一段终点', (() => {
    const allZero = P.buildTimeline([seg('a', SESSION_A, 3000, 3000), seg('b', SESSION_A, 8000, 8000)]);
    const l = P.locate(allZero, 0);
    return allZero.total === 0 && l.index === 1 && l.t === 8000 && l.atEnd === true;
  })());

  console.log('四、倍速映射：播放推进 dt×speed 后仍按累计区间时长映射');
  // 模拟播放循环：v += dt * speed，同一墙钟前进量在不同倍速下映射到不同原始时刻
  const dt = 1000; // 1 秒墙钟
  const at = (spd, from) => P.locate(tl, from + dt * spd);
  check('1×：1 秒墙钟前进 1 秒虚拟时长', at(1, 0).t === 11000);
  check('2×：1 秒墙钟前进 2 秒虚拟时长', at(2, 0).t === 12000);
  check('4×：1 秒墙钟前进 4 秒虚拟时长', at(4, 0).t === 14000);
  check('4× 跨段：从 38s 前进 4s → 恰好越界进入 B 场段内 2s', (() => {
    const l = at(4, 38000); // v=42000 → 第二段 20000+2000
    return l.index === 1 && l.t === 22000;
  })());
  check('4× 恰好落在边界 → 进入后一段起点', (() => {
    const l = at(4, 36000); // v=40000 → 边界 → 第二段起点
    return l.index === 1 && l.t === 20000;
  })());

  console.log('五、重叠区间：按清单顺序分别播放，绝不合并');
  const overlapTl = P.buildTimeline([
    seg('o1', SESSION_A, 10000, 20000), // 与 o2 完全相同的原始区间
    seg('o2', SESSION_A, 10000, 20000),
  ]);
  check('相同区间各自成段（时长各计一次）', overlapTl.segments.length === 2 && overlapTl.total === 20000);
  check('前半程映射到清单中先出现的段', P.locate(overlapTl, 5000).segment.key === 'o1' && P.locate(overlapTl, 5000).t === 15000);
  check('后半程映射到清单中后出现的段（同一原始时刻再播一遍）', (() => {
    const l = P.locate(overlapTl, 15000);
    return l.segment.key === 'o2' && l.t === 15000;
  })());
  check('重叠段边界仍进入后一段', P.locate(overlapTl, 10000).segment.key === 'o2' && P.locate(overlapTl, 10000).t === 10000);

  console.log('六、页面只读性（HTTP GET 静态页，无 WebSocket、无写接口）');
  const page = await httpGet('/playlist.html');
  check('播放页可访问', page.status === 200);
  check('播放页不创建 WebSocket', !/new\s+WebSocket/.test(page.body));
  check('播放页不出现任何写接口调用', !/fetch\(\s*['"`][^'"`]*(POST|PUT|DELETE)/i.test(page.body));
  check('播放页仅引用复盘只读 GET 接口', !page.body.includes('/api/') || /\/api\/replay\/sessions/.test(page.body));
  check('播放页引用时间轴模块 / 批注库 / 重放器',
    page.body.includes('playlist.js') && page.body.includes('annotations.js') && page.body.includes('replay.js'));
  check('播放页含倍速 1×/2×/4× 与虚拟时间轴',
    page.body.includes('data-speed="1"') && page.body.includes('data-speed="2"') && page.body.includes('data-speed="4"') && page.body.includes('vtimeline'));
  check('播放页集中列明跳过原因的区域存在', page.body.includes('skippedList') && page.body.includes('已自动跳过'));

  const annPage = await httpGet('/annotations.html');
  check('批注簿含复盘播放清单卡片', annPage.status === 200 && annPage.body.includes('复盘播放清单'));
  check('批注簿含「列入清单」勾选与拖拽排序', annPage.body.includes('列入清单') && annPage.body.includes('dragstart'));
  check('批注簿链接播放页', annPage.body.includes('playlist.html'));
  check('批注簿仍不创建 WebSocket', !/new\s+WebSocket/.test(annPage.body));

  const home = await httpGet('/');
  check('首页含播放清单入口', home.status === 200 && home.body.includes('playlist.html'));

  const noWriteApi = await httpGet('/api/playlist').catch(() => null);
  check('服务端不存在播放清单 API（清单只存 IndexedDB）', !noWriteApi || noWriteApi.status === 404);

  const annSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'annotations.js'), 'utf8');
  check('批注库 IndexedDB 含 playlist 存储与清单读写函数',
    annSrc.includes('PLAYLIST_STORE') && annSrc.includes('getPlaylist') && annSrc.includes('setPlaylist'));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
