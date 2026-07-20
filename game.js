/* ==========================================================================
   煩悩めくり — ゲームロジック
   プロトタイプ (煩悩めくり プロトタイプ.dc.html / DCLogic) を
   バニラJSへ忠実移植したもの。
   ========================================================================== */
(() => {
  'use strict';

  // --- ゲームバランス (プロトタイプの props default) --------------------
  const CONFIG = {
    goal: 36,        // 浄化すべき煩悩の総数
    bonnoRate: 0.6,  // めくった札が煩悩である確率
    faceUpMs: 2400,  // 札が表になっている基本時間(ms)
  };

  const BONNO = ['貪欲', '瞋恚', '愚痴', '慢心', '疑念', '嫉妬', '怠惰', '執着', '憤怒', '虚栄'];
  const TERMS = ['智慧', '布施', '慈悲', '精進', '忍辱', '禅定', '持戒', '菩提', '功徳', '涅槃'];

  // --- 状態 ------------------------------------------------------------
  const state = {
    phase: 'ready',   // ready | playing | clear | over
    hp: 100,
    mp: 0,
    purified: 0,
    chain: 0,
    maxChain: 0,
    cards: Array.from({ length: 9 }, (_, i) => ({
      id: i, st: 'down', word: '', bonno: false, timerOn: false, tok: 0,
    })),
    beam: null,     // {id, seq}
    attack: null,   // {word, sub, seq}
    bless: null,    // {id, seq}
    dmgSeq: 0,
    muted: false,
  };

  let timers = [];
  let upTok = 0;

  // ======================================================================
  //  オーディオ (WebAudio)
  // ======================================================================
  let _ac = null, _master = null, _bgm = null;

  function ac() {
    if (!_ac) {
      _ac = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ac.createGain();
      _master.gain.value = 0.5;
      _master.connect(_ac.destination);
    }
    if (_ac.state === 'suspended') _ac.resume();
    return _ac;
  }

  function tone(freq, t0, dur, type, vol, freqEnd) {
    const c = ac(), o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(_master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function noise(t0, dur, vol) {
    const c = ac(), len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = vol || 0.25;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    src.connect(f); f.connect(g); g.connect(_master);
    src.start(t0);
  }

  function sfx(kind) {
    if (state.muted) return;
    const c = ac(), t = c.currentTime;
    if (kind === 'flip') { tone(660, t, 0.08, 'triangle', 0.15, 880); }
    else if (kind === 'shoot') { tone(220, t, 0.12, 'sawtooth', 0.12, 440); tone(880, t + 0.02, 0.1, 'square', 0.06, 1320); }
    else if (kind === 'purify') { tone(1047, t, 0.35, 'sine', 0.22); tone(1568, t + 0.06, 0.4, 'sine', 0.15); tone(2093, t + 0.12, 0.5, 'sine', 0.1); }
    else if (kind === 'damage') { noise(t, 0.3, 0.3); tone(110, t, 0.4, 'sawtooth', 0.25, 55); }
    else if (kind === 'penalty') { tone(311, t, 0.25, 'square', 0.18, 155); tone(233, t + 0.12, 0.3, 'square', 0.15, 117); }
    else if (kind === 'clear') { [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.15, 0.6, 'sine', 0.2)); tone(1319, t + 0.6, 1.2, 'sine', 0.15); }
    else if (kind === 'over') { [330, 277, 220, 165].forEach((f, i) => tone(f, t + i * 0.2, 0.5, 'triangle', 0.2)); }
    else if (kind === 'bell') { tone(1760, t, 1.5, 'sine', 0.06); tone(2637, t, 0.8, 'sine', 0.025); }
    else if (kind === 'bless') { tone(784, t, 0.3, 'sine', 0.14); tone(1175, t + 0.08, 0.45, 'sine', 0.12); tone(1760, t + 0.16, 0.7, 'sine', 0.08); }
  }

  function startBgm() {
    if (_bgm) return;
    const scale = [220, 261.6, 293.7, 349.2, 392, 440];
    let step = 0;
    const tick = () => {
      if (state.phase === 'playing' && !state.muted) {
        const c = ac(), t = c.currentTime;
        const f = scale[[0, 2, 4, 3, 5, 2, 1, 0][step % 8]];
        tone(f / 2, t, 0.9, 'sine', 0.05);
        tone(f, t, 0.45, 'triangle', 0.045);
        if (step % 8 === 0) sfx('bell');
        step++;
      }
      _bgm = setTimeout(tick, 500);
    };
    tick();
  }
  function stopBgm() { clearTimeout(_bgm); _bgm = null; }

  // ======================================================================
  //  ヘルパ
  // ======================================================================
  const goal = () => CONFIG.goal;
  const rate = () => CONFIG.bonnoRate;
  const faceMs = () => Math.max(1300, CONFIG.faceUpMs - (state.purified / goal()) * 1000);

  function after(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function geo(id) {
    const col = id % 3, row = Math.floor(id / 3);
    return { x: 37 + col * 110, y: 130 + row * 152 };
  }

  function setCard(id, patch) {
    const c = state.cards[id];
    state.cards[id] = { ...c, ...patch };
    render();
  }

  // ======================================================================
  //  ゲーム進行
  // ======================================================================
  function start() {
    clearTimers();
    state.phase = 'playing';
    state.hp = 100; state.mp = 0; state.purified = 0;
    state.chain = 0; state.maxChain = 0;
    state.beam = null; state.attack = null; state.bless = null;
    state.dmgSeq = 0;
    state.cards = state.cards.map(c => ({ ...c, st: 'down', timerOn: false, word: '', bonno: false }));
    render();
    ac(); startBgm(); sfx('bell');
    after(800, flipNext);
  }

  function flipNext() {
    if (state.phase !== 'playing') return;
    const downs = state.cards.filter(c => c.st === 'down');
    if (!downs.length) { after(400, flipNext); return; }
    const pick = downs[Math.floor(Math.random() * downs.length)];
    const bonno = Math.random() < rate();
    const list = bonno ? BONNO : TERMS;
    const word = list[Math.floor(Math.random() * list.length)];
    upTok += 1;
    const tok = upTok, id = pick.id, dur = faceMs();
    setCard(id, { st: 'up', bonno, word, timerOn: false, tok });
    sfx('flip');
    // 50ms後にタイマー開始 (width 100%→0% のトランジションを発火させる)
    after(50, () => {
      const cc = state.cards[id];
      if (cc.st === 'up' && cc.tok === tok) setCard(id, { timerOn: true });
    });
    // 表示時間終了
    after(dur, () => {
      const cc = state.cards[id];
      if (cc.st === 'up' && cc.tok === tok) {
        setCard(id, { st: 'down', timerOn: false });
        if (cc.bonno) {
          damage(20, cc.word, '煩悩の襲来！');
        } else {
          state.mp = Math.min(100, state.mp + 10);
          state.bless = { id, seq: (state.bless ? state.bless.seq : 0) + 1 };
          render();
          sfx('bless');
          after(1100, () => { state.bless = null; render(); });
        }
      }
    });
    after(dur + 500 + Math.random() * 500, flipNext);
  }

  function damage(amount, word, sub) {
    state.hp = Math.max(0, state.hp - amount);
    state.chain = 0;
    state.attack = { word, sub, seq: (state.attack ? state.attack.seq : 0) + 1 };
    state.dmgSeq += 1;
    render();
    sfx('damage');
    after(750, () => {
      state.attack = null;
      render();
      if (state.hp <= 0 && state.phase === 'playing') {
        clearTimers();
        state.phase = 'over';
        render();
        sfx('over');
      }
    });
  }

  function shoot() {
    if (state.phase !== 'playing') return;
    const up = state.cards.find(c => c.st === 'up');
    if (!up) return;
    state.beam = { id: up.id, seq: (state.beam ? state.beam.seq : 0) + 1 };
    render();
    after(300, () => { state.beam = null; render(); });
    sfx('shoot');
    if (up.bonno) {
      after(120, () => sfx('purify'));
      setCard(up.id, { st: 'purify', timerOn: false });
      after(500, () => {
        if (state.cards[up.id].st === 'purify') setCard(up.id, { st: 'down' });
      });
      const chain = state.chain + 1;
      state.purified += 1;
      state.chain = chain;
      state.maxChain = Math.max(state.maxChain, chain);
      state.mp = Math.min(100, state.mp + 6);
      render();
      after(60, () => {
        if (state.purified >= goal() && state.phase === 'playing') {
          clearTimers();
          state.phase = 'clear';
          render();
          sfx('clear');
        }
      });
    } else {
      setCard(up.id, { st: 'down', timerOn: false });
      after(100, () => sfx('penalty'));
      damage(15, '罰', '仏教語を撃ってしまった…');
    }
  }

  function toggleMute() { state.muted = !state.muted; render(); }

  // ======================================================================
  //  描画
  // ======================================================================
  const el = {};
  const cardEls = [];

  function buildCards(board) {
    for (let i = 0; i < 9; i++) {
      const { x, y } = geo(i);
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.style.left = x + 'px';
      cell.style.top = y + 'px';
      cell.innerHTML = `
        <div class="card-inner">
          <div class="card-back">
            <div class="card-back-emblem">佛</div>
          </div>
          <div class="card-front">
            <div class="card-word"></div>
          </div>
        </div>
        <div class="card-badge"></div>
        <div class="card-timer"><div class="card-timer-fill"></div></div>
        <div class="card-purify">浄化!</div>`;
      board.appendChild(cell);
      cardEls.push({
        cell,
        inner: cell.querySelector('.card-inner'),
        front: cell.querySelector('.card-front'),
        word: cell.querySelector('.card-word'),
        badge: cell.querySelector('.card-badge'),
        timer: cell.querySelector('.card-timer'),
        timerFill: cell.querySelector('.card-timer-fill'),
        purify: cell.querySelector('.card-purify'),
      });
    }
  }

  function render() {
    const s = state, dur = faceMs();

    // HUD
    el.hpFill.style.width = s.hp + '%';
    el.mpFill.style.width = s.mp + '%';
    el.purifiedNum.textContent = s.purified;
    el.goalNum.textContent = goal();
    el.chainNum.textContent = s.chain;
    el.muteBtn.textContent = s.muted ? '消' : '音';

    // カード
    s.cards.forEach((c, i) => {
      const e = cardEls[i];
      const up = c.st === 'up' || c.st === 'purify';
      e.inner.className = 'card-inner' + (up ? ' up' : '');
      e.front.className = 'card-front' + (c.bonno ? ' bonno' : '') +
        (c.st === 'up' && c.bonno ? ' pulse' : '');
      e.word.className = 'card-word' + (c.bonno ? ' bonno' : '');
      e.word.textContent = c.word;
      e.badge.className = 'card-badge' + (c.bonno ? ' bonno' : '') + (c.st === 'up' ? ' show' : '');
      e.badge.textContent = c.bonno ? '煩悩!' : '仏教語';
      e.timer.className = 'card-timer' + (c.st === 'up' ? ' show' : '');
      e.timerFill.className = 'card-timer-fill' + (c.bonno ? ' bonno' : '');
      e.timerFill.style.width = c.timerOn ? '0%' : '100%';
      e.timerFill.style.transition = c.timerOn ? 'width ' + dur + 'ms linear' : 'none';
      e.purify.className = 'card-purify' + (c.st === 'purify' ? ' show' : '');
    });

    // ビーム
    if (s.beam) {
      const { x, y } = geo(s.beam.id);
      const top = y + 138;
      el.beam.style.left = (x + 44) + 'px';
      el.beam.style.top = top + 'px';
      el.beam.style.height = (690 - top) + 'px';
      el.beam.className = 'beam ' + (s.beam.seq % 2 ? 'on-a' : 'on-b');
    } else {
      el.beam.className = 'beam';
    }

    // 見送り成功
    if (s.bless) {
      const { x, y } = geo(s.bless.id);
      el.bless.style.left = (x - 12) + 'px';
      el.bless.style.top = (y + 44) + 'px';
      el.bless.textContent = '見送り成功 功徳+10';
      el.bless.className = 'bless ' + (s.bless.seq % 2 ? 'on-a' : 'on-b');
    } else {
      el.bless.className = 'bless';
    }

    // 照準ラベル
    const upCard = s.cards.find(c => c.st === 'up');
    el.aimLabel.textContent = upCard ? '自動照準：' + upCard.word : '照準：ーー';
    el.aimLabel.className = 'aim-label' +
      (upCard ? ' aiming' : '') + (upCard && upCard.bonno ? ' aiming-bonno' : '');

    // 揺れ
    el.shake.className = 'shake' + (s.dmgSeq ? (s.dmgSeq % 2 ? ' a' : ' b') : '');

    // 被弾演出
    el.attackWrap.className = 'attack-wrap' + (s.attack ? ' show' : '');
    if (s.attack) {
      el.attackWord.textContent = s.attack.word;
      el.attackWord.className = 'attack-word ' + (s.attack.seq % 2 ? 'a' : 'b');
      el.attackSub.textContent = s.attack.sub;
      el.attackSub.className = 'attack-sub ' + (s.attack.seq % 2 ? 'a' : 'b');
    }

    // ヴィネット
    el.vignette.className = 'vignette' + (s.dmgSeq ? (s.dmgSeq % 2 ? ' a' : ' b') : '');

    // オーバーレイ
    el.startScreen.hidden = s.phase !== 'ready';
    el.clearScreen.hidden = s.phase !== 'clear';
    el.overScreen.hidden = s.phase !== 'over';

    if (s.phase === 'clear') {
      el.clearGoal.textContent = goal();
      el.clearGoal2.textContent = goal();
      el.clearPurified.textContent = s.purified;
      el.clearMaxChain.textContent = s.maxChain;
      el.clearHp.textContent = s.hp;
    }
    if (s.phase === 'over') {
      el.overGoal.textContent = goal();
      el.overPurified.textContent = s.purified;
      el.overMaxChain.textContent = s.maxChain;
    }
  }

  // ======================================================================
  //  初期化
  // ======================================================================
  function init() {
    const ids = ['hpFill', 'mpFill', 'purifiedNum', 'goalNum', 'chainNum', 'muteBtn',
      'beam', 'bless', 'aimLabel', 'shake', 'attackWrap', 'attackWord', 'attackSub',
      'vignette', 'startScreen', 'clearScreen', 'overScreen',
      'clearGoal', 'clearGoal2', 'clearPurified', 'clearMaxChain', 'clearHp',
      'overGoal', 'overPurified', 'overMaxChain', 'startBtn', 'shootBtn'];
    ids.forEach(id => { el[id] = document.getElementById(id); });

    buildCards(document.getElementById('board'));

    el.startBtn.addEventListener('click', start);
    el.shootBtn.addEventListener('click', shoot);
    el.muteBtn.addEventListener('click', toggleMute);
    document.querySelectorAll('.restart-btn').forEach(b => b.addEventListener('click', start));

    // PC: Spaceキー
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (state.phase === 'playing') shoot();
        else start();
      }
    });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
