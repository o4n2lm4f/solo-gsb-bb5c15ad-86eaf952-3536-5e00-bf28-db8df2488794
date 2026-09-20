/* 复盘播放清单前端逻辑：把清单中各批注圈定的区间按顺序拼接成一条虚拟时间轴。
 *
 * 纯函数、无副作用：不触碰 IndexedDB / 网络 / DOM，浏览器页面与 Node 测试
 * 共用同一份实现（与 public/replay.js 的确定性重放器同一思路）。
 *
 * 虚拟时间轴规则：
 *   - 每段区间时长 = max(0, endT - startT)，各段按清单顺序首尾相接，
 *     绝不因原始时刻重叠而合并——重叠区间按清单顺序分别播放；
 *   - 虚拟时刻 v ∈ [0, total] 按累计区间时长映射到对应场次的原始时刻：
 *     落在第 i 段半开区间 [vStart, vEnd) 内 → 原始时刻 = startT_i + (v - vStart_i)；
 *   - 恰好落在边界（v == vEnd_i）时进入后一段（半开区间的自然结果）；
 *   - v >= total（末尾）钳制到最后一段的终点；v < 0 钳制到 0。
 *   - 零长区间（startT == endT）时长为 0，不占用虚拟时间轴，顺序播放时自然越过。
 */
'use strict';

const CuePlaylist = (() => {
  // 由清单条目（已按清单顺序）构建虚拟时间轴。
  // items: [{ key, fileId, runId, startT, endT, ... }]（其余字段原样保留在段上）
  // 返回 { segments: [...], total }；segments 中每段附 vStart / vEnd / duration / index。
  function buildTimeline(items) {
    const segments = [];
    let acc = 0;
    (Array.isArray(items) ? items : []).forEach((it, i) => {
      const startT = Number(it && it.startT);
      const endT = Number(it && it.endT);
      const s = Number.isFinite(startT) ? startT : 0;
      const e = Number.isFinite(endT) ? endT : s;
      const duration = Math.max(0, e - s); // 负时长按 0 计，绝不反向映射
      segments.push({
        ...it,
        index: i,
        startT: s,
        endT: e,
        duration,
        vStart: acc,
        vEnd: acc + duration,
      });
      acc += duration;
    });
    return { segments, total: acc };
  }

  // 虚拟时刻 → 对应场次原始时刻。
  // 返回 { index, segment, t, atEnd }；空时间轴返回 null。
  // 边界规则：v 恰好等于某段 vEnd 时不属于该段（半开区间），继续进入后一段；
  // 仅当 v >= total 时钳制到最后一段的终点（atEnd: true）。
  function locate(timeline, v) {
    if (!timeline || !Array.isArray(timeline.segments) || timeline.segments.length === 0) return null;
    const segments = timeline.segments;
    const total = Number(timeline.total) || 0;
    let vv = Number(v);
    if (!Number.isFinite(vv)) vv = 0;
    vv = Math.max(0, Math.min(total, vv));
    if (vv >= total) {
      const last = segments[segments.length - 1];
      return { index: segments.length - 1, segment: last, t: last.endT, atEnd: true };
    }
    for (const seg of segments) {
      // 半开区间 [vStart, vEnd)：零长段（vStart == vEnd）天然被跳过
      if (vv < seg.vEnd) {
        return { index: seg.index, segment: seg, t: seg.startT + (vv - seg.vStart), atEnd: false };
      }
    }
    // 理论不可达（vv < total 时必有某段 vEnd > vv）
    const last = segments[segments.length - 1];
    return { index: segments.length - 1, segment: last, t: last.endT, atEnd: true };
  }

  return { buildTimeline, locate };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CuePlaylist };
}
