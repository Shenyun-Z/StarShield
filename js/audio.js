/*
 * audio.js —— 《星盾防线》音效模块（零依赖 · Web Audio）
 * 浏览器自动播放策略：必须在用户首次交互后才能创建/恢复 AudioContext。
 *   → 在 input.js 的 mousedown 里调用 audio.unlock() 解锁。
 * 导出（全局 window.audio）：
 *   audio.init() / audio.unlock() / audio.play(name)
 * 音效名：
 *   'place' 放置星体（清脆短促）
 *   'boom'  陨石撞毁（噪声爆破 + 低音）
 *   'suck'  黑洞吸入（下滑音）
 *   'hit'   撞击母星（沉闷重击）
 *   'flee'  安全飞出边界（轻盈 pip）
 */
(function (global) {
  'use strict';

  let ctx = null;
  let enabled = true;

  // 读取本地音效开关（file:// 下个别浏览器可能限制，try 兜底）
  try { enabled = localStorage.getItem('starshield_audio') !== 'off'; }
  catch (e) { enabled = true; }

  // 创建 AudioContext（仅一次）
  function init() {
    if (ctx || !enabled) return;
    try {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { enabled = false; return; }
      ctx = new AC();
    } catch (e) {
      enabled = false;
    }
  }

  // 在用户首次交互时调用：创建并 resume（解锁自动播放限制）
  function unlock() {
    init();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
  }

  // 基础合成音：振荡器 + 指数包络
  function tone(opts) {
    if (!enabled || !ctx) return;
    const t0 = ctx.currentTime;
    const dur = opts.dur || 0.2;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.f0, t0);
    if (opts.f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + dur);
    const peak = opts.gain != null ? opts.gain : 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // 噪声爆破（用于撞击/重击质感）
  function noiseBurst(dur, gain) {
    if (!enabled || !ctx) return;
    const t0 = ctx.currentTime;
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1100;
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start(t0); src.stop(t0 + dur);
  }

  // 音效开关：关闭时不创建/播放任何声音，状态本地持久化
  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem('starshield_audio', on ? 'on' : 'off'); }
    catch (e) {}
    if (on) init();                       // 重新开启时确保 AudioContext 就绪
  }

  function isEnabled() { return enabled; }

  function play(name) {
    if (!enabled) return;
    init();
    switch (name) {
      case 'place': // 放置：短促清脆上滑
        tone({ type: 'triangle', f0: 520, f1: 760, dur: 0.10, gain: 0.16 });
        break;
      case 'boom': // 撞毁：噪声 + 低音下坠
        noiseBurst(0.34, 0.34);
        tone({ type: 'sine', f0: 190, f1: 55, dur: 0.34, gain: 0.24 });
        break;
      case 'suck': // 吸入：下滑锯齿
        tone({ type: 'sawtooth', f0: 620, f1: 120, dur: 0.42, gain: 0.17 });
        break;
      case 'hit': // 撞母星：沉闷重击
        noiseBurst(0.40, 0.40);
        tone({ type: 'square', f0: 110, f1: 38, dur: 0.44, gain: 0.28 });
        break;
      case 'flee': // 飞出：轻盈上滑 pip
        tone({ type: 'sine', f0: 880, f1: 1320, dur: 0.14, gain: 0.10 });
        break;
      default:
        break;
    }
  }

  const audio = { init: init, unlock: unlock, play: play,
                  setEnabled: setEnabled, isEnabled: isEnabled };
  global.audio = audio;
})(typeof window !== 'undefined' ? window : globalThis);
