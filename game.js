/* ==========================================================================
   煩悩ビンゴ — ゲームロジック
   5×5 のビンゴ盤。カードが1枚ずつ自動でめくれる(自動照準)。
   単語は見えるが「煩悩」か「仏教語」かは読経を撃つ/見送るまで分からない。
   ・煩悩を読経で撃つ    → 正解 → そのマス成立(○)
   ・仏教語を見送る      → 正解 → そのマス成立(○)
   ・仏教語を撃つ        → 誤り → 被弾・不成立(✕)
   ・煩悩を見逃す        → 誤り → 被弾・不成立(✕)
   一度めくったマスは裏返らず、成立マスが縦横斜めに揃うとビンゴ。
   規定数のビンゴでクリア。
   ========================================================================== */
(() => {
  'use strict';

  // --- 盤面サイズ -------------------------------------------------------
  const SIZE = 5;
  const CELLS = SIZE * SIZE; // 25

  // --- ゲームバランス --------------------------------------------------
  const CONFIG = {
    bingoGoal: 3,    // クリアに必要なビンゴ本数(複数)
    bonnoRate: 0.6,  // 各マスが煩悩である確率
    faceUpMs: 2800,  // 札が表(判断可能)になっている基本時間(ms)
  };

  const BONNO = ['貪欲', '瞋恚', '愚痴', '慢心', '疑念', '嫉妬', '怠惰', '執着', '憤怒', '虚栄'];
  const TERMS = ['智慧', '布施', '慈悲', '精進', '忍辱', '禅定', '持戒', '菩提', '功徳', '涅槃'];

  // --- 全ビンゴライン(行5・列5・斜め2) ------------------------------
  const LINES = (() => {
    const lines = [];
    for (let r = 0; r < SIZE; r++) lines.push(Array.from({ length: SIZE }, (_, c) => r * SIZE + c));
    for (let c = 0; c < SIZE; c++) lines.push(Array.from({ length: SIZE }, (_, r) => r * SIZE + c));
    lines.push(Array.from({ length: SIZE }, (_, i) => i * SIZE + i));
    lines.push(Array.from({ length: SIZE }, (_, i) => i * SIZE + (SIZE - 1 - i)));
    return lines;
  })();

  // --- 状態 ------------------------------------------------------------
  const state = {
    phase: 'ready',   // ready | playing | clear | over
    hp: 100,
    mp: 0,
    purified: 0,      // 撃破した煩悩の数(統計用)
    marked: 0,        // 成立したマス数
    bingo: 0,         // 成立したビンゴ本数
    chain: 0,
    maxChain: 0,
    resolved: 0,      // 判定済みマス数
    // 各マス: st(down/up) resolved(判定済み) bonno(正体) word marked(成立)
    //         correct(正誤) revealed(正体開示) timerOn tok
    cards: Array.from({ length: CELLS }, (_, i) => ({
      id: i, st: 'down', resolved: false, bonno: false, word: '',
      marked: false, correct: false, revealed: false, timerOn: false, tok: 0,
    })),
    beam: null,     // {id, seq}
    attack: null,   // {word, sub, seq, kind}
    bless: null,    // {id, seq}
    bingoFx: null,  // {seq, cells, count}
    bingoLines: [], // 演出済みビンゴライン(LINESのindex)
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
    else if (kind === 'bingo') { [784, 988, 1319, 1568].forEach((f, i) => tone(f, t + i * 0.08, 0.4, 'square', 0.16)); }
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
  const bingoGoal = () => CONFIG.bingoGoal;
  const rate = () => CONFIG.bonnoRate;
  const faceMs = () => Math.max(1600, CONFIG.faceUpMs - (state.resolved / CELLS) * 1000);

  function after(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function geo(id) {
    const col = id % SIZE, row = Math.floor(id / SIZE);
    return { x: 19 + col * 72, y: 118 + row * 96 };
  }

  function setCard(id, patch) {
    const c = state.cards[id];
    state.cards[id] = { ...c, ...patch };
    render();
  }

  // 成立ライン(LINESのindex配列)を返す
  function completedLines() {
    const res = [];
    LINES.forEach((line, idx) => {
      if (line.every(i => state.cards[i].marked)) res.push(idx);
    });
    return res;
  }

  // 成立マスからビンゴ本数を数える
  function countBingo() { return completedLines().length; }

  // ======================================================================
  //  ゲーム進行
  // ======================================================================
  function start() {
    clearTimers();
    state.phase = 'playing';
    state.hp = 100; state.mp = 0;
    state.purified = 0; state.marked = 0; state.bingo = 0;
    state.chain = 0; state.maxChain = 0; state.resolved = 0;
    state.beam = null; state.attack = null; state.bless = null;
    state.bingoFx = null; state.bingoLines = [];
    state.dmgSeq = 0;
    // 盤面を固定生成(正体は伏せたまま)
    state.cards = state.cards.map((c, i) => {
      const bonno = Math.random() < rate();
      const list = bonno ? BONNO : TERMS;
      const word = list[Math.floor(Math.random() * list.length)];
      return {
        id: i, st: 'down', resolved: false, bonno, word,
        marked: false, correct: false, revealed: false, timerOn: false, tok: 0,
      };
    });
    render();
    ac(); startBgm(); sfx('bell');
    after(800, flipNext);
  }

  function flipNext() {
    if (state.phase !== 'playing') return;
    const downs = state.cards.filter(c => c.st === 'down');
    if (!downs.length) return; // 全マスめくり終わり(判定は各resolveで終了処理)
    const pick = downs[Math.floor(Math.random() * downs.length)];
    upTok += 1;
    const tok = upTok, id = pick.id, dur = faceMs();
    // めくる:単語は見せるが正体(色)は伏せたまま
    setCard(id, { st: 'up', revealed: false, timerOn: false, tok });
    sfx('flip');
    // 50ms後にタイマー開始(width 100%→0% のトランジションを発火)
    after(50, () => {
      const cc = state.cards[id];
      if (cc.st === 'up' && !cc.resolved && cc.tok === tok) setCard(id, { timerOn: true });
    });
    // 表示時間終了 = 見送り(読経しなかった)判定
    after(dur, () => {
      const cc = state.cards[id];
      if (cc.st === 'up' && !cc.resolved && cc.tok === tok) {
        resolve(id, false); // fired = false(見送り)
      }
    });
  }

  // マス判定。fired: プレイヤーが読経を撃ったか
  function resolve(id, fired) {
    const c = state.cards[id];
    if (c.resolved) return;
    const correct = fired ? c.bonno : !c.bonno; // 煩悩を撃つ or 仏教語を見送る = 正解
    setCard(id, { resolved: true, revealed: true, timerOn: false, correct, marked: correct });
    state.resolved += 1;

    if (correct) {
      state.marked += 1;
      state.chain += 1;
      state.maxChain = Math.max(state.maxChain, state.chain);
      if (c.bonno) {
        state.purified += 1;
        state.mp = Math.min(100, state.mp + 6);
        after(120, () => sfx('purify'));
      } else {
        // 見送り成功
        state.mp = Math.min(100, state.mp + 10);
        state.bless = { id, seq: (state.bless ? state.bless.seq : 0) + 1 };
        sfx('bless');
        after(1100, () => { state.bless = null; render(); });
      }
      render();
      // ビンゴ判定 + 演出
      const doneLines = completedLines();
      const newLines = doneLines.filter(idx => !state.bingoLines.includes(idx));
      if (newLines.length) {
        state.bingoLines = doneLines;
        state.bingo = doneLines.length;
        // 新規に揃ったライン上のマスを集約(重複除去)
        const cells = [];
        newLines.forEach(idx => LINES[idx].forEach(i => { if (!cells.includes(i)) cells.push(i); }));
        state.bingoFx = { seq: (state.bingoFx ? state.bingoFx.seq : 0) + 1, cells, count: doneLines.length };
        render();
        after(140, () => sfx('bingo'));
        after(1300, () => { state.bingoFx = null; render(); });
      }
      after(120, () => {
        if (state.bingo >= bingoGoal() && state.phase === 'playing') {
          clearTimers();
          state.phase = 'clear';
          render();
          sfx('clear');
          return;
        }
        checkEndAndAdvance();
      });
    } else {
      // 誤り:被弾
      state.chain = 0;
      if (c.bonno) {
        // 煩悩を見逃した → 叱責
        damage(20, '見逃したな！', `「${c.word}」に呑まれた`, 'miss');
      } else {
        // 仏教語を撃ってしまった
        after(100, () => sfx('penalty'));
        damage(15, '罰', '仏教語を撃ってしまった…', 'wrong');
      }
      after(160, checkEndAndAdvance);
    }
  }

  // 次のマスへ / 全マス判定済みなら終了判定
  function checkEndAndAdvance() {
    if (state.phase !== 'playing') return;
    if (state.hp <= 0) return; // 致命被弾時は damage 側のゲームオーバー処理に委ねる
    if (state.resolved >= CELLS) {
      clearTimers();
      state.phase = state.bingo >= bingoGoal() ? 'clear' : 'over';
      render();
      sfx(state.phase === 'clear' ? 'clear' : 'over');
      return;
    }
    after(450 + Math.random() * 350, flipNext);
  }

  function damage(amount, word, sub, kind) {
    state.hp = Math.max(0, state.hp - amount);
    state.attack = { word, sub, kind: kind || 'wrong', seq: (state.attack ? state.attack.seq : 0) + 1 };
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
    // 自動照準:めくれていて未判定のマス
    const up = state.cards.find(c => c.st === 'up' && !c.resolved);
    if (!up) return;
    state.beam = { id: up.id, seq: (state.beam ? state.beam.seq : 0) + 1 };
    render();
    after(300, () => { state.beam = null; render(); });
    sfx('shoot');
    resolve(up.id, true);
  }

  function toggleMute() { state.muted = !state.muted; render(); }

  // ======================================================================
  //  描画
  // ======================================================================
  const el = {};
  const cardEls = [];

  function buildCards(board) {
    for (let i = 0; i < CELLS; i++) {
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
        <div class="card-mark"></div>
        <div class="card-purify">浄</div>`;
      board.appendChild(cell);
      cardEls.push({
        cell,
        inner: cell.querySelector('.card-inner'),
        front: cell.querySelector('.card-front'),
        word: cell.querySelector('.card-word'),
        badge: cell.querySelector('.card-badge'),
        timer: cell.querySelector('.card-timer'),
        timerFill: cell.querySelector('.card-timer-fill'),
        mark: cell.querySelector('.card-mark'),
        purify: cell.querySelector('.card-purify'),
      });
    }
  }

  function render() {
    const s = state, dur = faceMs();

    // HUD
    el.hpFill.style.width = s.hp + '%';
    el.mpFill.style.width = s.mp + '%';
    el.bingoNum.textContent = s.bingo;
    el.goalNum.textContent = bingoGoal();
    el.chainNum.textContent = s.chain;
    el.muteBtn.textContent = s.muted ? '消' : '音';

    // カード
    s.cards.forEach((c, i) => {
      const e = cardEls[i];
      const up = c.st === 'up';
      const active = up && !c.resolved;
      // ビンゴ成立ライン上のマスを発光
      const inBingo = s.bingoFx && s.bingoFx.cells.includes(i);
      e.cell.className = 'cell' + (inBingo ? ' bingo-line' : '');
      e.inner.className = 'card-inner' + (up ? ' up' : '');
      // 正体は revealed(判定済み)まで伏せる。未判定は無色、判定後は正誤で色
      e.front.className = 'card-front'
        + (active ? ' active' : '')
        + (c.revealed && c.bonno ? ' reveal-bonno' : '')
        + (c.revealed && !c.bonno ? ' reveal-term' : '');
      e.word.className = 'card-word'
        + (c.revealed && c.bonno ? ' bonno' : '')
        + (c.revealed && !c.bonno ? ' term' : '');
      e.word.textContent = c.word;
      // バッジは判定後に正体を表示
      e.badge.className = 'card-badge'
        + (c.bonno ? ' bonno' : '')
        + (c.revealed ? ' show' : '');
      e.badge.textContent = c.bonno ? '煩悩' : '仏教語';
      // タイマーは判定中(active)のみ。色は伏せるため常に中立色
      e.timer.className = 'card-timer' + (active ? ' show' : '');
      e.timerFill.className = 'card-timer-fill';
      e.timerFill.style.width = c.timerOn ? '0%' : '100%';
      e.timerFill.style.transition = c.timerOn ? 'width ' + dur + 'ms linear' : 'none';
      // 成立/不成立マーク
      e.mark.className = 'card-mark'
        + (c.resolved ? (c.correct ? ' ok' : ' ng') : '');
      e.mark.textContent = c.resolved ? (c.correct ? '○' : '✕') : '';
      // 浄化演出(煩悩を撃った瞬間)
      e.purify.className = 'card-purify'
        + (c.resolved && c.correct && c.bonno ? ' show' : '');
    });

    // ビーム
    if (s.beam) {
      const { x, y } = geo(s.beam.id);
      const top = y + 92;
      el.beam.style.left = (x + 28) + 'px';
      el.beam.style.top = top + 'px';
      el.beam.style.height = (700 - top) + 'px';
      el.beam.className = 'beam ' + (s.beam.seq % 2 ? 'on-a' : 'on-b');
    } else {
      el.beam.className = 'beam';
    }

    // 見送り成功
    if (s.bless) {
      const { x, y } = geo(s.bless.id);
      el.bless.style.left = (x - 28) + 'px';
      el.bless.style.top = (y + 20) + 'px';
      el.bless.textContent = '見送り成功 功徳+10';
      el.bless.className = 'bless ' + (s.bless.seq % 2 ? 'on-a' : 'on-b');
    } else {
      el.bless.className = 'bless';
    }

    // ビンゴ演出バナー
    el.bingoFx.className = 'bingo-fx' + (s.bingoFx ? (s.bingoFx.seq % 2 ? ' on-a' : ' on-b') : '');

    // 照準ラベル(正体は伏せるので中立表示)
    const upCard = s.cards.find(c => c.st === 'up' && !c.resolved);
    el.aimLabel.textContent = upCard ? '照準：' + upCard.word : '照準：ーー';
    el.aimLabel.className = 'aim-label' + (upCard ? ' aiming' : '');

    // 揺れ
    el.shake.className = 'shake' + (s.dmgSeq ? (s.dmgSeq % 2 ? ' a' : ' b') : '');

    // 被弾演出
    el.attackWrap.className = 'attack-wrap' + (s.attack ? ' show' : '');
    if (s.attack) {
      el.attackWord.textContent = s.attack.word;
      el.attackWord.className = 'attack-word ' + (s.attack.kind || 'wrong') + ' ' + (s.attack.seq % 2 ? 'a' : 'b');
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
      el.clearGoal.textContent = s.bingo;
      el.clearGoal2.textContent = bingoGoal();
      el.clearPurified.textContent = s.bingo;
      el.clearMaxChain.textContent = s.maxChain;
      el.clearHp.textContent = s.hp;
    }
    if (s.phase === 'over') {
      el.overGoal.textContent = bingoGoal();
      el.overPurified.textContent = s.bingo;
      el.overMaxChain.textContent = s.maxChain;
    }
  }

  // ======================================================================
  //  初期化
  // ======================================================================
  function init() {
    const ids = ['hpFill', 'mpFill', 'bingoNum', 'goalNum', 'chainNum', 'muteBtn',
      'beam', 'bless', 'bingoFx', 'aimLabel', 'shake', 'attackWrap', 'attackWord', 'attackSub',
      'vignette', 'startScreen', 'clearScreen', 'overScreen',
      'clearGoal', 'clearGoal2', 'clearPurified', 'clearMaxChain', 'clearHp',
      'overGoal', 'overPurified', 'overMaxChain', 'startBtn', 'shootBtn', 'versionTag'];
    ids.forEach(id => { el[id] = document.getElementById(id); });

    // バージョン表示(デプロイ毎に CI が置換。未置換ならローカル扱いで dev)
    if (el.versionTag) {
      const raw = String(window.APP_VERSION || '').trim();
      el.versionTag.textContent = (raw && !raw.includes('__')) ? raw : 'dev';
    }

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
