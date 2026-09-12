(() => {
  const COLORS = [
    { key: 'green', label: '緑' },
    { key: 'pink', label: '桃' },
    { key: 'blue', label: '青' },
    { key: 'red', label: '赤' },
    { key: 'orange', label: '橙' },
  ];

  const TILE_MAP = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1;
    return {
      n,
      color: COLORS[(n - 1) % 5].key,
      dots: (Math.floor((n - 1) / 5) % 3) + 1,
    };
  });

  const $ = id => document.getElementById(id);

  const els = {
    setup: $('setupScreen'),
    waiting: $('waitingScreen'),
    game: $('gameScreen'),
    result: $('resultScreen'),
    configWarning: $('configWarning'),

    cpuPlayerName: $('cpuPlayerName'),
    cpuStart: $('cpuStartBtn'),

    hostName: $('hostName'),
    guestName: $('guestName'),
    roomInput: $('roomCodeInput'),
    create2: $('createBtn'),
    create3: $('create3Btn'),
    join: $('joinBtn'),

    roomCodeBig: $('roomCodeBig'),
    waitingText: $('waitingText'),
    copyCode: $('copyCodeBtn'),
    leave: $('leaveBtn'),
    soundToggle: $('soundToggleBtn'),

    roomMini: $('roomMini'),
    turnText: $('turnText'),
    meBadge: $('meBadge'),

    opponentsArea: $('opponentsArea'),
    myHand: $('myHand'),
    myHandHint: $('myHandHint'),
    publicTiles: $('publicTiles'),
    phaseText: $('phaseText'),

    drawPanel: $('drawPanel'),
    drawColors: $('drawColors'),
    cluePanel: $('cluePanel'),
    selectedTileView: $('selectedTileView'),
    clueButtons: $('clueButtons'),
    categorize: $('categorizeBtn'),
    compare: $('compareBtn'),
    comparePositions: $('comparePositions'),

    clueLog: $('clueLog'),
    deductionGrid: $('deductionGrid'),
    resetNotes: $('resetNotesBtn'),
    gotFive: $('gotFiveBtn'),

    modal: $('modal'),
    modalTitle: $('modalTitle'),
    modalBody: $('modalBody'),
    modalClose: $('modalClose'),
    toast: $('toast'),

    resultIcon: $('resultIcon'),
    resultTitle: $('resultTitle'),
    resultText: $('resultText'),
    newGame: $('newGameBtn'),
    backHome: $('backHomeBtn'),
  };

  let sb = null;
  let session = JSON.parse(localStorage.getItem('fiveLogicSession') || 'null');
  let room = null;
  let channel = null;
  let selectedPublic = null;
  let cpuTimer = null;
  let previousMyTurn = null;
  let previousStatus = null;
  let autoSkipRevision = null;
  let lastScrollKey = null;
  let lastRenderedClueCount = 0;

  // 固定表示の推理ボードが操作ボタン(分類/比較/GOT FIVE)を隠してしまわないよう、
  // 自分の手番になった/フェーズが変わった時に操作エリアを自動でスクロール表示する。
  function maybeAutoScrollToAction(myTurn, gameOver, eliminated) {
    if (gameOver || eliminated || !myTurn || !room) {
      lastScrollKey = null;
      return;
    }

    const key = `${room.turn}:${room.phase}:${selectedPublic || ''}`;
    if (key === lastScrollKey) return;
    lastScrollKey = key;

    requestAnimationFrame(() => {
      if (els.gotFive && !els.gotFive.classList.contains('hidden')) {
        els.gotFive.scrollIntoView({ block: 'end', behavior: 'auto' });
      }
    });
  }

  /* =========================
     Sound
  ========================= */

  let audioContext = null;
  let audioEnabled = localStorage.getItem('fiveLogicSound') !== 'off';

  function updateSoundButton() {
    if (els.soundToggle) {
      els.soundToggle.textContent = audioEnabled ? '🔊 ON' : '🔇 OFF';
    }
  }

  function ensureAudio() {
    if (!audioEnabled) return;

    if (!audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioContext = new Ctx();
    }

    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }

  function playTone(freq, duration, delay = 0, volume = 0.09) {
    if (!audioEnabled) return;
    ensureAudio();
    if (!audioContext) return;

    const start = audioContext.currentTime + delay;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  function playTurnSound() {
    playTone(660, 0.12, 0);
    playTone(880, 0.18, 0.12);
  }

  function playWinSound() {
    playTone(523, 0.13, 0);
    playTone(659, 0.13, 0.13);
    playTone(784, 0.24, 0.26);
  }

  function playLoseSound() {
    playTone(440, 0.15, 0);
    playTone(349, 0.16, 0.15);
    playTone(294, 0.25, 0.31);
  }

  function toggleSound() {
    audioEnabled = !audioEnabled;
    localStorage.setItem('fiveLogicSound', audioEnabled ? 'on' : 'off');
    updateSoundButton();

    if (audioEnabled) {
      ensureAudio();
      playTone(800, 0.12);
    }
  }

  updateSoundButton();

  document.addEventListener('pointerdown', () => {
    ensureAudio();
  }, { once: true });

  /* =========================
     Supabase
  ========================= */

  // Supabase CDNスクリプトの読み込みに失敗しても(通信不安定・広告ブロッカー・
  // 企業/学校ネットワーク等)、CPU戦はSupabase不要でオフライン動作できる必要が
  // あるため、ここで例外を投げてスクリプト全体を止めてしまわないようにする。
  let configured = Boolean(
    window.SUPABASE_URL &&
    window.SUPABASE_ANON_KEY &&
    window.supabase &&
    typeof window.supabase.createClient === 'function'
  );

  if (configured) {
    try {
      sb = window.supabase.createClient(
        window.SUPABASE_URL,
        window.SUPABASE_ANON_KEY
      );
    } catch (error) {
      console.error('Supabaseクライアントの初期化に失敗しました', error);
      sb = null;
      configured = false;
    }
  }

  if (!configured && els.configWarning) {
    const hasKeys = Boolean(window.SUPABASE_URL && window.SUPABASE_ANON_KEY);
    if (!hasKeys) {
      els.configWarning.classList.remove('hidden');
    } else {
      // キーはあるがライブラリ読み込み等に失敗したケース。原因が分かるようにする。
      els.configWarning.classList.remove('hidden');
      const span = els.configWarning.querySelector('span');
      if (span) {
        span.textContent = 'Supabaseへの接続に失敗しました(通信環境をご確認ください)。CPU戦は引き続き遊べます。';
      }
    }
  }

  /* =========================
     Helpers
  ========================= */

  function normalizeSession() {
    if (!session) return;
    if (session.mode === 'cpu') session.mode = 'cpu2';
    if (session.mode === 'online') session.mode = 'online2';
  }

  function normalizeRoom(state) {
    if (!state) return state;

    if (state.mode === 'cpu') state.mode = 'cpu2';
    if (state.mode === 'online') state.mode = 'online2';

    state.players = (state.players || []).map(p =>
      p ? { eliminated: false, ...p } : p
    );

    if (!Array.isArray(state.guesses)) {
      state.guesses = state.guess ? [state.guess] : [];
    }

    if (typeof state.revision !== 'number') {
      state.revision = 0;
    }

    if (state.mode === 'cpu2') {
      state.cpuIndex = 1;
      state.playerCount = 2;
    } else if (state.mode === 'online3cpu') {
      state.cpuIndex = 2;
      state.playerCount = 3;
    } else {
      state.cpuIndex = null;
      state.playerCount = 2;
    }

    return state;
  }

  normalizeSession();

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      els.toast.classList.add('hidden');
    }, 1800);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randCode(length = 6) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const values = new Uint32Array(length);
    crypto.getRandomValues(values);
    return [...values].map(v => chars[v % chars.length]).join('');
  }

  function randToken() {
    return crypto.randomUUID?.() || randCode(18);
  }

  function tileByN(n) {
    return TILE_MAP[n - 1];
  }

  function colorLabel(key) {
    return COLORS.find(c => c.key === key)?.label || key;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function humanIndex() {
    if (!session) return 0;
    if (session.mode === 'cpu2') return 0;
    return session.playerIndex ?? 0;
  }

  function cpuIndex() {
    return room?.cpuIndex ?? null;
  }

  function isLocalMode() {
    return room?.mode === 'cpu2' || session?.mode === 'cpu2';
  }

  function isCpuController() {
    if (!room || cpuIndex() === null) return false;
    if (room.mode === 'cpu2') return true;
    if (room.mode === 'online3cpu') return session?.playerIndex === 0;
    return false;
  }

  function activePlayerIndices(state = room) {
    return state.players
      .map((p, i) => ({ p, i }))
      .filter(x => x.p && !x.p.eliminated)
      .map(x => x.i);
  }

  function nextActiveIndex(current, state = room) {
    const count = state.players.length;

    for (let step = 1; step <= count; step++) {
      const i = (current + step) % count;
      if (state.players[i] && !state.players[i].eliminated) return i;
    }

    return current;
  }

  function maybeFinishForLastPlayer(state) {
    const active = activePlayerIndices(state);

    if (active.length === 1) {
      state.status = 'finished';
      state.winner = active[0];
      return true;
    }

    return false;
  }

  function displayModeName() {
    if (room.mode === 'cpu2') return 'CPU BATTLE';
    if (room.mode === 'online3cpu') return '3 PLAYER';
    return `ROOM ${session.code}`;
  }

  /* =========================
     Room / setup
  ========================= */

  function buildInitialState(hostName, hostToken, mode) {
    if (mode === 'online3cpu') {
      return {
        version: 3,
        mode,
        playerCount: 3,
        cpuIndex: 2,
        status: 'waiting',
        turn: 0,
        phase: 'draw',
        winner: null,
        revision: 0,
        players: [
          { name: hostName, token: hostToken, hand: [], eliminated: false },
          null,
          { name: 'CPU', token: 'cpu', hand: [], eliminated: false },
        ],
        remaining: TILE_MAP.map(t => t.n),
        public: [],
        clues: [],
        guesses: [],
        round: 1,
        createdAt: new Date().toISOString(),
      };
    }

    return {
      version: 3,
      mode,
      playerCount: 2,
      cpuIndex: mode === 'cpu2' ? 1 : null,
      status: mode === 'cpu2' ? 'playing' : 'waiting',
      turn: 0,
      phase: 'draw',
      winner: null,
      revision: 0,
      players: mode === 'cpu2'
        ? [
            { name: hostName, token: hostToken, hand: [], eliminated: false },
            { name: 'CPU', token: 'cpu', hand: [], eliminated: false },
          ]
        : [
            { name: hostName, token: hostToken, hand: [], eliminated: false },
            null,
          ],
      remaining: TILE_MAP.map(t => t.n),
      public: [],
      clues: [],
      guesses: [],
      round: 1,
      createdAt: new Date().toISOString(),
    };
  }

  function setupGame(state) {
    state = normalizeRoom(state);

    const remaining = new Set(TILE_MAP.map(t => t.n));

    state.players.forEach(p => {
      if (p) {
        p.hand = [];
        p.eliminated = false;
      }
    });

    for (let p = 0; p < state.players.length; p++) {
      if (!state.players[p]) continue;

      for (const color of COLORS) {
        const options = [...remaining].filter(
          n => tileByN(n).color === color.key
        );

        const n = options[Math.floor(Math.random() * options.length)];
        state.players[p].hand.push(n);
        remaining.delete(n);
      }

      state.players[p].hand.sort((a, b) => a - b);
    }

    const publicTiles = [];

    for (const color of COLORS) {
      const options = [...remaining].filter(
        n => tileByN(n).color === color.key
      );

      const n = options[Math.floor(Math.random() * options.length)];
      publicTiles.push(n);
      remaining.delete(n);
    }

    state.remaining = [...remaining];
    state.public = publicTiles;
    state.clues = [];
    state.guesses = [];
    state.turn = 0;
    state.phase = 'draw';
    state.status = 'playing';
    state.winner = null;
    state.round = 1;
    // dealIdを毎回発行し直すことで、推理ボードの印を新しい対局ごとに
    // 全端末(ホスト・ゲスト双方)で自動的にリセットする(notesKey参照)。
    state.dealId = randToken();

    return state;
  }

  async function fetchRoom(code) {
    const { data, error } = await sb
      .from('godfive_rooms')
      .select('*')
      .eq('code', code)
      .single();

    if (error) throw error;

    data.state = normalizeRoom(data.state);
    // revisionはDBの列を正とする(state内の値は移行期の互換用)。
    data.state.revision = data.revision || 0;
    return data;
  }

  function persistCpuRoom() {
    if (isLocalMode() && room) {
      localStorage.setItem('fiveLogicCpuRoom', JSON.stringify(room));
    }
  }

  // revisionによる楽観的排他制御。
  // 書き込み時に「読んだ時点のrevisionのままである」ことをDB側で確認し、
  // 一致した場合だけ更新する。これにより以下を防ぐ:
  //  - 二重操作/同じ手番で2回操作できてしまう
  //  - 古いstateで新しいstateを上書きしてしまう
  //  - CPUが2回行動してしまう
  //  - 2台の間で手番がずれる
  // 競合(他の操作が先に反映された)場合は、そのまま最新状態を取得して
  // ローカル表示を復元する(このアクションは静かに破棄される)。
  async function saveState(next, options = {}) {
    const { scheduleCpu = true } = options;

    next = normalizeRoom(next);
    selectedPublic = null;

    if (isLocalMode()) {
      room = next;
      persistCpuRoom();
      render();

      if (scheduleCpu) maybeScheduleCpu();
      return true;
    }

    const prevRevision = room?.revision || 0;
    next.revision = prevRevision + 1;
    room = next;
    render();

    try {
      const { data, error } = await sb
        .from('godfive_rooms')
        .update({
          state: next,
          revision: next.revision,
          updated_at: new Date().toISOString(),
        })
        .eq('code', session.code)
        .eq('revision', prevRevision)
        .select('state, revision');

      if (error) throw error;

      if (!data || data.length === 0) {
        // 競合: 他の書き込みが先にrevisionを進めていた。
        const latest = await fetchRoom(session.code);
        room = latest.state;
        render();
        toast('他の操作と重なったため、最新の状態を反映しました');
        return false;
      }

      return true;
    } catch (error) {
      console.error(error);
      toast('通信に失敗しました');
      return false;
    } finally {
      if (scheduleCpu) maybeScheduleCpu();
    }
  }

  function startCpuGame() {
    ensureAudio();

    const name = els.cpuPlayerName.value.trim() || 'あなた';
    const token = randToken();

    let state = buildInitialState(name, token, 'cpu2');
    state = setupGame(state);

    session = {
      mode: 'cpu2',
      code: 'CPU',
      token,
      playerIndex: 0,
    };

    room = state;

    localStorage.setItem('fiveLogicSession', JSON.stringify(session));
    persistCpuRoom();

    previousMyTurn = null;
    previousStatus = null;

    render();
  }

  async function createOnlineRoom(mode) {
    ensureAudio();

    if (!configured) {
      toast('オンライン対戦にはSupabase設定が必要です');
      return;
    }

    const name = els.hostName.value.trim();

    if (!name) {
      toast('名前を入力してください');
      return;
    }

    const token = randToken();
    let code = null;
    let created = false;

    for (let i = 0; i < 10 && !created; i++) {
      code = randCode();
      const state = buildInitialState(name, token, mode);

      const { error } = await sb
        .from('godfive_rooms')
        .insert({ code, state, revision: 0 });

      if (!error) created = true;
    }

    if (!created) {
      toast('部屋を作れませんでした');
      return;
    }

    session = {
      mode,
      code,
      token,
      playerIndex: 0,
    };

    localStorage.setItem('fiveLogicSession', JSON.stringify(session));

    previousMyTurn = null;
    previousStatus = null;

    await connectRoom();
  }

  async function joinRoom() {
    ensureAudio();

    if (!configured) {
      toast('オンライン対戦にはSupabase設定が必要です');
      return;
    }

    const name = els.guestName.value.trim();
    const code = els.roomInput.value.trim().toUpperCase();

    if (!name || code.length !== 6) {
      toast('名前と6文字コードを入力してください');
      return;
    }

    // 同時に2人が参加しようとした場合の競合に備え、revisionガード付きで
    // 数回まで再試行する(片方が先に埋めたら、もう一方は満員判定になる)。
    for (let attempt = 0; attempt < 4; attempt++) {
      let row;

      try {
        row = await fetchRoom(code);
      } catch (error) {
        console.error(error);
        const notFound =
          error?.code === 'PGRST116' ||
          /no rows|not found|json object requested/i.test(error?.message || '');
        toast(notFound ? '部屋が存在しません。コードを確認してください' : '通信に失敗しました');
        return;
      }

      const state = row.state;

      if (state.status !== 'waiting') {
        toast('この部屋はすでに開始されています');
        return;
      }

      const openIndex = state.players.findIndex(p => p === null);

      if (openIndex < 0) {
        toast('この部屋は満員です');
        return;
      }

      const token = randToken();

      state.players[openIndex] = {
        name,
        token,
        hand: [],
        eliminated: false,
      };

      setupGame(state);

      const prevRevision = row.revision || 0;
      state.revision = prevRevision + 1;

      let updateResult;

      try {
        updateResult = await sb
          .from('godfive_rooms')
          .update({
            state,
            revision: state.revision,
            updated_at: new Date().toISOString(),
          })
          .eq('code', code)
          .eq('revision', prevRevision)
          .select('state, revision');
      } catch (error) {
        console.error(error);
        toast('通信に失敗しました');
        return;
      }

      if (updateResult.error) {
        console.error(updateResult.error);
        toast('通信に失敗しました');
        return;
      }

      if (!updateResult.data || updateResult.data.length === 0) {
        // 他の誰かが同時に参加した。最新状態で座席を取り直す。
        continue;
      }

      session = {
        mode: state.mode,
        code,
        token,
        playerIndex: openIndex,
      };

      localStorage.setItem('fiveLogicSession', JSON.stringify(session));

      previousMyTurn = null;
      previousStatus = null;

      await connectRoom();
      return;
    }

    toast('参加に失敗しました。もう一度お試しください');
  }

  /* =========================
     Connection
  ========================= */

  async function connectRoom() {
    if (!session) return;

    normalizeSession();

    if (session.mode === 'cpu2') {
      room = normalizeRoom(
        JSON.parse(localStorage.getItem('fiveLogicCpuRoom') || 'null')
      );

      if (!room) {
        clearSession();
        return;
      }

      render();
      maybeScheduleCpu();
      return;
    }

    if (!configured) return;

    try {
      const row = await fetchRoom(session.code);

      const idx = row.state.players.findIndex(
        p => p?.token === session.token
      );

      if (idx < 0) {
        clearSession();
        return;
      }

      session.mode = row.state.mode;
      session.playerIndex = idx;

      localStorage.setItem('fiveLogicSession', JSON.stringify(session));

      room = row.state;

      subscribe();
      render();
      maybeScheduleCpu();

    } catch (error) {
      console.error(error);
      clearSession();
    }
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);

    channel = sb
      .channel('room-' + session.code)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'godfive_rooms',
          filter: `code=eq.${session.code}`,
        },
        payload => {
          if (!payload.new) return;

          const incomingRevision = payload.new.revision || 0;

          // 順序が入れ替わって古い更新が後から届いても、
          // 現在より新しいrevisionでなければ無視する(巻き戻り防止)。
          if (room && typeof room.revision === 'number' && incomingRevision < room.revision) {
            return;
          }

          const nextState = normalizeRoom(payload.new.state);
          nextState.revision = incomingRevision;

          room = nextState;
          selectedPublic = null;
          render();
          maybeScheduleCpu();
        }
      )
      .subscribe();
  }

  /* =========================
     View
  ========================= */

  function show(screen) {
    [els.setup, els.waiting, els.game, els.result].forEach(
      s => s.classList.add('hidden')
    );

    screen.classList.remove('hidden');

    els.leave.classList.toggle(
      'hidden',
      screen === els.setup
    );
  }

  function tileHTML(n, hidden = false, selectable = false) {
    const t = tileByN(n);

    return `
      <div class="tile ${t.color} ${hidden ? 'hidden-num' : ''} ${selectable ? 'selectable' : ''}" data-n="${n}">
        <div class="num">${hidden ? '?' : n}</div>
        <div class="dots">${hidden ? '' : '●'.repeat(t.dots)}</div>
        <div class="color-name">${colorLabel(t.color)}</div>
      </div>
    `;
  }

  function handleSoundState() {
    if (!room || !session) return;

    const meIndex = humanIndex();
    const me = room.players[meIndex];

    const myTurn =
      room.status === 'playing' &&
      !me?.eliminated &&
      room.turn === meIndex;

    if (
      previousMyTurn !== null &&
      previousMyTurn === false &&
      myTurn === true
    ) {
      playTurnSound();
    }

    if (
      previousStatus === 'playing' &&
      room.status === 'finished'
    ) {
      if (room.winner === meIndex) {
        playWinSound();
      } else {
        playLoseSound();
      }
    }

    previousMyTurn = myTurn;
    previousStatus = room.status;
  }

  function renderOpponents(gameOver) {
    const meIndex = humanIndex();

    const opponents = room.players
      .map((p, i) => ({ p, i }))
      .filter(x => x.p && x.i !== meIndex);

    els.opponentsArea.innerHTML = opponents.map(({ p, i }) => {
      const isCpu = i === cpuIndex();
      const stateClass = p.eliminated ? 'out' : isCpu ? 'cpu' : '';
      const stateText = p.eliminated ? '脱落' : isCpu ? 'CPU' : '対戦相手';

      return `
        <section class="board-section opponent-board ${p.eliminated ? 'eliminated' : ''}">
          <div class="section-title-row">
            <h2>${escapeHtml(p.name)} の5枚</h2>
            <span class="player-state ${stateClass}">${stateText}</span>
          </div>
          <div class="rack">
            ${p.hand.map(n => tileHTML(n, false)).join('')}
          </div>
        </section>
      `;
    }).join('');
  }

  function render() {
    if (!room || !session) {
      show(els.setup);
      return;
    }

    room = normalizeRoom(room);
    handleSoundState();

    if (room.status === 'waiting') {
      show(els.waiting);
      els.roomCodeBig.textContent = session.code;
      els.waitingText.textContent =
        room.mode === 'online3cpu'
          ? 'もう1人の参加を待っています。参加するとCPUを加えた3人戦が始まります。'
          : '相手の参加を待っています…';
      return;
    }

    show(els.game);

    const gameOver = room.status === 'finished';
    const meIndex = humanIndex();
    const me = room.players[meIndex];
    const myTurn =
      !gameOver &&
      !me.eliminated &&
      room.turn === meIndex;

    els.roomMini.textContent =
      room.mode === 'online3cpu'
        ? `3 PLAYER / ROOM ${session.code}`
        : displayModeName();

    els.meBadge.textContent =
      me.eliminated ? `${me.name}（脱落）` : me.name;

    if (gameOver) {
      const winnerName = room.players[room.winner]?.name || 'プレイヤー';
      els.turnText.textContent = `ゲーム終了：${winnerName} の勝利`;

    } else if (me.eliminated) {
      els.turnText.textContent = 'あなたは脱落しました。観戦中です';

    } else if (myTurn) {
      els.turnText.textContent = 'あなたの番です';

    } else {
      const current = room.players[room.turn];
      els.turnText.textContent =
        room.turn === cpuIndex()
          ? 'CPUが考えています…'
          : `${current?.name || '相手'} の番です`;
    }

    // 極めて稀なケースだが、全色の山が尽きた場合に「引く」段階のまま
    // 詰んでしまわないよう、場のタイルだけで手がかりを出す段階へ進める。
    if (
      !gameOver &&
      !me.eliminated &&
      myTurn &&
      room.phase === 'draw' &&
      room.public.length > 0 &&
      COLORS.every(c => !room.remaining.some(n => tileByN(n).color === c.key)) &&
      autoSkipRevision !== room.revision
    ) {
      autoSkipRevision = room.revision;
      const next = structuredClone(room);
      next.phase = 'clue';
      setTimeout(() => saveState(next, { scheduleCpu: false }), 0);
    }

    renderOpponents(gameOver);

    els.myHandHint.textContent =
      gameOver ? '最終公開' : '数字は秘密';

    els.myHand.innerHTML =
      me.hand
        .map(n => tileHTML(n, !gameOver))
        .join('');

    els.publicTiles.innerHTML =
      room.public
        .map(n => tileHTML(n, false, !gameOver))
        .join('');

    if (!gameOver && !me.eliminated) {
      [...els.publicTiles.querySelectorAll('.tile')].forEach(node => {
        const n = Number(node.dataset.n);

        if (n === selectedPublic) node.classList.add('selected');

        node.onclick = () => {
          if (!myTurn || room.phase !== 'clue') return;
          selectedPublic = n;
          renderActionState();
          maybeAutoScrollToAction(myTurn, gameOver, me.eliminated);
        };
      });
    }

    renderClues();
    renderDeduction();

    if (gameOver) {
      els.drawPanel.classList.add('hidden');
      els.cluePanel.classList.add('hidden');
      els.phaseText.textContent = '最終局面';
      els.gotFive.classList.add('hidden');

      els.result.classList.remove('hidden');
      renderResult();
      return;
    }

    els.result.classList.add('hidden');

    if (me.eliminated) {
      els.drawPanel.classList.add('hidden');
      els.cluePanel.classList.add('hidden');
      els.gotFive.classList.add('hidden');
      els.phaseText.textContent = '観戦中';
      return;
    }

    els.gotFive.classList.remove('hidden');
    renderActionState();
    maybeAutoScrollToAction(myTurn, gameOver, me.eliminated);
  }

  function renderActionState() {
    const meIndex = humanIndex();
    const me = room.players[meIndex];
    const myTurn =
      !me.eliminated &&
      room.turn === meIndex;

    els.drawPanel.classList.toggle(
      'hidden',
      !(myTurn && room.phase === 'draw')
    );

    els.cluePanel.classList.toggle(
      'hidden',
      !(myTurn && room.phase === 'clue')
    );

    if (!myTurn) {
      els.phaseText.textContent =
        room.turn === cpuIndex()
          ? 'CPUの操作中'
          : '相手の操作待ち';
    } else {
      els.phaseText.textContent =
        room.phase === 'draw'
          ? 'まず1枚公開'
          : '手がかりを選択';
    }

    if (myTurn && room.phase === 'draw') {
      els.drawColors.innerHTML = COLORS.map(c => {
        const left = room.remaining.filter(
          n => tileByN(n).color === c.key
        ).length;

        return `
          <button
            class="color-dot ${c.key}"
            data-color="${c.key}"
            ${left === 0 ? 'disabled' : ''}
            title="${c.label} 残り${left}枚"
          ></button>
        `;
      }).join('');

      [...els.drawColors.querySelectorAll('button')].forEach(button => {
        button.onclick = () => drawTile(button.dataset.color);
      });
    }

    if (myTurn && room.phase === 'clue') {
      els.selectedTileView.classList.toggle('hidden', !selectedPublic);
      els.clueButtons.classList.toggle('hidden', !selectedPublic);
      els.comparePositions.classList.add('hidden');

      if (selectedPublic) {
        els.selectedTileView.innerHTML = tileHTML(selectedPublic);
      }
    }
  }

  /* =========================
     Human actions
  ========================= */

  async function drawTile(color) {
    color = String(color || '').trim();

    const meIndex = humanIndex();

    if (
      room.status !== 'playing' ||
      room.players[meIndex].eliminated ||
      room.turn !== meIndex ||
      room.phase !== 'draw'
    ) return;

    const options = room.remaining.filter(
      n => tileByN(n).color === color
    );

    if (!options.length) {
      toast('この山は空です');
      return;
    }

    const n = options[Math.floor(Math.random() * options.length)];
    const next = structuredClone(room);

    next.remaining = next.remaining.filter(x => x !== n);
    next.public.push(n);
    next.phase = 'clue';

    await saveState(next);
  }

  async function categorize() {
    if (!selectedPublic) return;

    const meIndex = humanIndex();
    const next = structuredClone(room);
    const hand = next.players[meIndex].hand;

    let slot = 0;

    while (
      slot < hand.length &&
      selectedPublic > hand[slot]
    ) {
      slot++;
    }

    next.clues.push({
      by: meIndex,
      type: 'categorize',
      tile: selectedPublic,
      slot,
      round: next.round,
      at: Date.now(),
    });

    consumeAndPass(next, selectedPublic);
    await saveState(next);
  }

  function openCompare() {
    if (!selectedPublic) return;

    els.comparePositions.classList.remove('hidden');

    els.comparePositions.innerHTML = Array.from(
      { length: 5 },
      (_, i) => `<button data-pos="${i}">${i + 1}番目</button>`
    ).join('');

    [...els.comparePositions.querySelectorAll('button')].forEach(button => {
      button.onclick = () =>
        compareAt(Number(button.dataset.pos));
    });

    requestAnimationFrame(() => {
      els.comparePositions.scrollIntoView({ block: 'end', behavior: 'auto' });
    });
  }

  async function compareAt(pos) {
    if (!selectedPublic) return;

    const meIndex = humanIndex();
    const next = structuredClone(room);
    const hiddenN = next.players[meIndex].hand[pos];

    const yes =
      tileByN(hiddenN).dots ===
      tileByN(selectedPublic).dots;

    next.clues.push({
      by: meIndex,
      type: 'compare',
      tile: selectedPublic,
      pos,
      yes,
      round: next.round,
      at: Date.now(),
    });

    consumeAndPass(next, selectedPublic);
    await saveState(next);
  }

  function consumeAndPass(next, tileN) {
    const current = next.turn;

    next.public = next.public.filter(n => n !== tileN);
    next.phase = 'draw';

    const nextTurn = nextActiveIndex(current, next);

    if (nextTurn <= current) {
      next.round++;
    }

    next.turn = nextTurn;
    selectedPublic = null;
  }

  /* =========================
     Clues / notes
  ========================= */

  // 手がかりを文章ではなく、実際に駒(タイル)が自分の5枚のどこに
  // 入るか/どこと比べたかが分かるミニ図解として表示する。
  function renderClues() {
    const items = [...room.clues].reverse();
    const isNewTop = room.clues.length > lastRenderedClueCount;
    lastRenderedClueCount = room.clues.length;

    els.clueLog.innerHTML = '';

    if (!items.length) {
      lastRenderedClueCount = 0;
      els.clueLog.innerHTML = '<div class="small">まだ手がかりはありません。</div>';
      return;
    }

    items.forEach((clue, idx) => {
      const who = room.players[clue.by]?.name || 'プレイヤー';
      const t = tileByN(clue.tile);

      const card = document.createElement('div');
      card.className =
        'clue-card' +
        (clue.by === humanIndex() ? ' mine' : '') +
        (idx === 0 && isNewTop ? ' new' : '');

      const head = document.createElement('div');
      head.className = 'clue-head';
      head.innerHTML = `
        <span class="clue-name">${escapeHtml(who)}</span>
        <span class="clue-badge ${clue.type === 'compare' ? 'compare' : ''}">${clue.type === 'compare' ? '比較' : '分類'}</span>
      `;
      card.appendChild(head);

      const track = document.createElement('div');

      if (clue.type === 'categorize') {
        // 5枚(未公開)の間の6つの「隙間」のどこにタイルが入るかを、
        // 実際にタイルをその隙間へ差し込む形で表示する。
        track.className = 'clue-track';

        for (let gap = 0; gap <= 5; gap++) {
          const gapEl = document.createElement('span');

          if (gap === clue.slot) {
            gapEl.className = 'slot-gap active';
            gapEl.innerHTML = `
              <span class="mini-tile ${t.color}">
                ${clue.tile}
                <div class="mini-dots">${'●'.repeat(t.dots)}</div>
              </span>
            `;
          } else {
            gapEl.className = 'slot-gap';
          }

          track.appendChild(gapEl);

          if (gap < 5) {
            const slotEl = document.createElement('span');
            slotEl.className = 'mini-slot';
            track.appendChild(slotEl);
          }
        }
      } else {
        // 5枚(未公開)のうち、どの位置と比べたかをハイライトし、
        // 実際に公開されたタイルを「=(同じ)/≠(違う)」でつなげて表示する。
        track.className = 'clue-track compare-track';

        for (let pos = 0; pos < 5; pos++) {
          const slotEl = document.createElement('span');

          if (pos === clue.pos) {
            slotEl.className = 'mini-slot highlight';
            slotEl.textContent = String(pos + 1);
          } else {
            slotEl.className = 'mini-slot';
          }

          track.appendChild(slotEl);
        }

        const link = document.createElement('span');
        link.className = `compare-link ${clue.yes ? 'same' : 'diff'}`;
        link.textContent = clue.yes ? '=' : '≠';
        track.appendChild(link);

        const tileEl = document.createElement('span');
        tileEl.className = `mini-tile ${t.color}`;
        tileEl.innerHTML = `${clue.tile}<div class="mini-dots">${'●'.repeat(t.dots)}</div>`;
        track.appendChild(tileEl);
      }

      card.appendChild(track);
      els.clueLog.appendChild(card);
    });
  }

  function notesKey() {
    // dealId(対局ごとに再発行される)を含めることで、再戦のたびに
    // ホスト・ゲスト双方の推理ボードが自動的にまっさらな状態になる。
    const dealId = room?.dealId || 'legacy';
    return `fiveLogicNotes:${session.code}:${session.token}:${dealId}`;
  }

  function getNotes() {
    return new Set(
      JSON.parse(localStorage.getItem(notesKey()) || '[]')
    );
  }

  function saveNotes(set) {
    localStorage.setItem(
      notesKey(),
      JSON.stringify([...set])
    );
  }

  function renderDeduction() {
    const notes = getNotes();
    els.deductionGrid.innerHTML = '';

    COLORS.forEach(color => {
      const row = document.createElement('div');
      row.className = 'deduction-row';

      const label = document.createElement('div');
      label.className = `row-label ${color.key}`;
      row.appendChild(label);

      TILE_MAP
        .filter(t => t.color === color.key)
        .forEach(t => {
          const cell = document.createElement('div');

          cell.className =
            `deduction-cell ${t.color}` +
            (notes.has(t.n) ? ' crossed' : '');

          cell.innerHTML = `
            <div class="cell-num">${t.n}</div>
            <div class="cell-dots">${'●'.repeat(t.dots)}</div>
          `;

          cell.onclick = () => {
            const set = getNotes();

            if (set.has(t.n)) {
              set.delete(t.n);
            } else {
              set.add(t.n);
            }

            saveNotes(set);
            renderDeduction();
          };

          row.appendChild(cell);
        });

      els.deductionGrid.appendChild(row);
    });
  }

  /* =========================
     GOT FIVE
     Wrong guess => eliminated.
     In 2-player this immediately gives the other player the win.
     In 3-player the remaining players continue.
  ========================= */

  function openGuess() {
    const me = room.players[humanIndex()];

    if (me.eliminated || room.status !== 'playing') return;

    els.modalTitle.textContent = 'GOT FIVE!';

    els.modalBody.innerHTML = `
      <p class="small">
        自分の5枚を小さい順に入力してください。間違えると脱落します。
      </p>

      <div class="guess-grid">
        ${Array.from(
          { length: 5 },
          (_, i) => `
            <input
              class="guess"
              type="number"
              min="1"
              max="60"
              inputmode="numeric"
              placeholder="${i + 1}"
            >
          `
        ).join('')}
      </div>

      <button id="submitGuess" class="danger wide">
        この5つで宣言する
      </button>
    `;

    els.modal.classList.remove('hidden');
    $('submitGuess').onclick = submitGuess;
  }

  async function submitGuess() {
    const values = [...document.querySelectorAll('.guess')]
      .map(input => Number(input.value));

    if (
      values.some(
        v =>
          !Number.isInteger(v) ||
          v < 1 ||
          v > 60
      )
    ) {
      toast('1〜60を5つ入力してください');
      return;
    }

    const sorted = [...values].sort((a, b) => a - b);

    if (sorted.some((v, i) => v !== values[i])) {
      toast('小さい順に入力してください');
      return;
    }

    const meIndex = humanIndex();
    const next = structuredClone(room);

    const correct = values.every(
      (v, i) =>
        v === next.players[meIndex].hand[i]
    );

    const guess = {
      player: meIndex,
      values,
      correct,
      at: Date.now(),
    };

    next.guesses.push(guess);

    if (correct) {
      next.status = 'finished';
      next.winner = meIndex;

    } else {
      next.players[meIndex].eliminated = true;

      if (!maybeFinishForLastPlayer(next)) {
        // 3人戦で自分だけ脱落し、ゲーム自体は続く場合はこの場で敗北音を鳴らす。
        // (ゲームが終了するケースはhandleSoundStateの勝敗音に任せ、二重再生を避ける)
        playLoseSound();

        const nextTurn = nextActiveIndex(meIndex, next);

        if (nextTurn <= meIndex) {
          next.round++;
        }

        next.turn = nextTurn;
        next.phase = 'draw';
      }
    }

    els.modal.classList.add('hidden');
    await saveState(next);
  }

  function renderResult() {
    const me = humanIndex();
    const won = room.winner === me;
    const winnerName = room.players[room.winner]?.name || 'プレイヤー';
    const lastGuess = room.guesses?.[room.guesses.length - 1] || null;

    els.resultIcon.textContent = won ? '★' : '×';
    els.resultTitle.textContent = won ? '勝利！' : `${winnerName} の勝利`;

    if (lastGuess?.correct) {
      els.resultText.textContent =
        `${room.players[lastGuess.player].name} が5つの数字をすべて当てました。最終盤面を確認できます。`;
    } else if (lastGuess) {
      els.resultText.textContent =
        `${room.players[lastGuess.player].name} の宣言が外れ、最後まで残った ${winnerName} が勝利しました。`;
    } else {
      els.resultText.textContent =
        `${winnerName} の勝利です。最終盤面を確認できます。`;
    }
  }

  /* =========================
     CPU deduction
  ========================= */

  function visibleNumbersForCpu() {
    const ci = cpuIndex();
    const visible = new Set();

    room.players.forEach((p, i) => {
      if (!p || i === ci) return;
      p.hand.forEach(n => visible.add(n));
    });

    room.public.forEach(n => visible.add(n));
    room.clues.forEach(clue => visible.add(clue.tile));

    return visible;
  }

  function baseCandidatesByPosition() {
    const ci = cpuIndex();
    const visible = visibleNumbersForCpu();

    return room.players[ci].hand.map(actualN => {
      const color = tileByN(actualN).color;

      return TILE_MAP
        .filter(
          t =>
            t.color === color &&
            !visible.has(t.n)
        )
        .map(t => t.n)
        .sort((a, b) => a - b);
    });
  }

  function tupleMatchesCpuClues(tuple) {
    const ci = cpuIndex();

    for (const clue of room.clues) {
      if (clue.by !== ci) continue;

      if (clue.type === 'compare') {
        const same =
          tileByN(tuple[clue.pos]).dots ===
          tileByN(clue.tile).dots;

        if (same !== clue.yes) return false;
      }

      if (clue.type === 'categorize') {
        let slot = 0;

        while (
          slot < tuple.length &&
          clue.tile > tuple[slot]
        ) {
          slot++;
        }

        if (slot !== clue.slot) return false;
      }
    }

    return true;
  }

  function cpuCandidateTuples(useClues = true) {
    const byPos = baseCandidatesByPosition();
    const tuples = [];

    function dfs(pos, current) {
      if (pos === 5) {
        if (
          !useClues ||
          tupleMatchesCpuClues(current)
        ) {
          tuples.push([...current]);
        }
        return;
      }

      const prev =
        pos === 0
          ? -Infinity
          : current[pos - 1];

      for (const n of byPos[pos]) {
        if (n <= prev) continue;

        if (
          pos < 4 &&
          !byPos[pos + 1].some(nextN => nextN > n)
        ) {
          continue;
        }

        current.push(n);
        dfs(pos + 1, current);
        current.pop();
      }
    }

    dfs(0, []);
    return tuples;
  }

  function expectedRemaining(partitionSizes, total) {
    if (!total) return Infinity;

    let sum = 0;

    for (const size of partitionSizes) {
      sum += size * size;
    }

    return sum / total;
  }

  function evaluateCompareQuestion(tuples, publicTile, pos) {
    let yes = 0;
    let no = 0;

    const targetDots = tileByN(publicTile).dots;

    for (const tuple of tuples) {
      if (tileByN(tuple[pos]).dots === targetDots) {
        yes++;
      } else {
        no++;
      }
    }

    if (yes === 0 || no === 0) return null;

    return {
      type: 'compare',
      tile: publicTile,
      pos,
      score: expectedRemaining([yes, no], tuples.length),
    };
  }

  function evaluateCategorizeQuestion(tuples, publicTile) {
    const buckets = [0, 0, 0, 0, 0, 0];

    for (const tuple of tuples) {
      let slot = 0;

      while (
        slot < tuple.length &&
        publicTile > tuple[slot]
      ) {
        slot++;
      }

      buckets[slot]++;
    }

    const nonZero = buckets.filter(n => n > 0);

    if (nonZero.length <= 1) return null;

    return {
      type: 'categorize',
      tile: publicTile,
      score: expectedRemaining(nonZero, tuples.length),
    };
  }

  function chooseBestCpuQuestion(tuples) {
    const questions = [];

    for (const publicTile of room.public) {
      const category =
        evaluateCategorizeQuestion(
          tuples,
          publicTile
        );

      if (category) questions.push(category);

      for (let pos = 0; pos < 5; pos++) {
        const compare =
          evaluateCompareQuestion(
            tuples,
            publicTile,
            pos
          );

        if (compare) questions.push(compare);
      }
    }

    if (!questions.length) {
      return {
        type: 'categorize',
        tile: room.public[
          Math.floor(Math.random() * room.public.length)
        ],
      };
    }

    questions.sort((a, b) => a.score - b.score);

    const bestScore = questions[0].score;
    const nearBest = questions.filter(
      q => q.score <= bestScore + 0.25
    );

    return nearBest[
      Math.floor(Math.random() * nearBest.length)
    ];
  }

  function chooseCpuDrawColor(tuples) {
    const ci = cpuIndex();

    const available = COLORS.filter(c =>
      room.remaining.some(
        n => tileByN(n).color === c.key
      )
    );

    if (!available.length) return null;

    const uncertainty = new Map();

    for (let pos = 0; pos < 5; pos++) {
      const actualColor =
        tileByN(
          room.players[ci].hand[pos]
        ).color;

      const unique =
        new Set(
          tuples.map(tuple => tuple[pos])
        );

      uncertainty.set(
        actualColor,
        Math.max(
          uncertainty.get(actualColor) || 0,
          unique.size
        )
      );
    }

    available.sort((a, b) =>
      (uncertainty.get(b.key) || 0) -
      (uncertainty.get(a.key) || 0)
    );

    const best =
      uncertainty.get(available[0].key) || 0;

    const pool = available.filter(
      c =>
        (uncertainty.get(c.key) || 0) === best
    );

    return pool[
      Math.floor(Math.random() * pool.length)
    ].key;
  }

  async function cpuDeclare(tuple) {
    const ci = cpuIndex();
    const next = structuredClone(room);
    const guess = [...tuple];

    const correct = guess.every(
      (n, i) =>
        n === next.players[ci].hand[i]
    );

    next.guesses.push({
      player: ci,
      values: guess,
      correct,
      at: Date.now(),
    });

    if (correct) {
      next.status = 'finished';
      next.winner = ci;

    } else {
      next.players[ci].eliminated = true;

      if (!maybeFinishForLastPlayer(next)) {
        const nextTurn = nextActiveIndex(ci, next);

        if (nextTurn <= ci) {
          next.round++;
        }

        next.turn = nextTurn;
        next.phase = 'draw';
      }
    }

    await saveState(next, { scheduleCpu: false });
  }

  function maybeScheduleCpu() {
    clearTimeout(cpuTimer);

    if (
      !room ||
      room.status !== 'playing' ||
      cpuIndex() === null ||
      room.turn !== cpuIndex() ||
      room.phase !== 'draw' ||
      room.players[cpuIndex()]?.eliminated ||
      !isCpuController()
    ) {
      return;
    }

    cpuTimer = setTimeout(cpuTakeTurn, 650);
  }

  async function cpuTakeTurn() {
    const ci = cpuIndex();

    if (
      !isCpuController() ||
      room.status !== 'playing' ||
      room.turn !== ci ||
      room.phase !== 'draw' ||
      room.players[ci].eliminated
    ) return;

    let tuples = cpuCandidateTuples();

    if (tuples.length === 0) {
      console.warn('CPU candidate tuples became empty; falling back.');
      tuples = cpuCandidateTuples(false);
    }

    if (tuples.length === 1) {
      await sleep(450);
      await cpuDeclare(tuples[0]);
      return;
    }

    const color = chooseCpuDrawColor(tuples);
    if (!color) return;

    const drawOptions = room.remaining.filter(
      n => tileByN(n).color === color
    );

    if (!drawOptions.length) return;

    const drawn =
      drawOptions[
        Math.floor(Math.random() * drawOptions.length)
      ];

    let next = structuredClone(room);

    next.remaining =
      next.remaining.filter(n => n !== drawn);

    next.public.push(drawn);
    next.phase = 'clue';

    await saveState(next, { scheduleCpu: false });

    await sleep(800);

    if (
      room.status !== 'playing' ||
      room.turn !== ci ||
      room.phase !== 'clue'
    ) return;

    tuples = cpuCandidateTuples();

    if (tuples.length === 0) {
      tuples = cpuCandidateTuples(false);
    }

    if (tuples.length === 1) {
      await sleep(300);
      await cpuDeclare(tuples[0]);
      return;
    }

    const action = chooseBestCpuQuestion(tuples);
    next = structuredClone(room);

    if (action.type === 'compare') {
      const hiddenN =
        next.players[ci].hand[action.pos];

      const yes =
        tileByN(hiddenN).dots ===
        tileByN(action.tile).dots;

      next.clues.push({
        by: ci,
        type: 'compare',
        tile: action.tile,
        pos: action.pos,
        yes,
        round: next.round,
        at: Date.now(),
      });

    } else {
      const hand = next.players[ci].hand;

      let slot = 0;

      while (
        slot < hand.length &&
        action.tile > hand[slot]
      ) {
        slot++;
      }

      next.clues.push({
        by: ci,
        type: 'categorize',
        tile: action.tile,
        slot,
        round: next.round,
        at: Date.now(),
      });
    }

    consumeAndPass(next, action.tile);

    await saveState(next);
  }

  /* =========================
     Rematch / exit
  ========================= */

  async function rematch() {
    if (room.mode === 'cpu2') {
      const next = setupGame(structuredClone(room));

      localStorage.removeItem(notesKey());
      previousMyTurn = null;
      previousStatus = null;

      await saveState(next);
      return;
    }

    if (session.playerIndex !== 0) {
      toast('部屋を作った人が再戦を開始します');
      return;
    }

    const next = setupGame(structuredClone(room));

    localStorage.removeItem(notesKey());
    previousMyTurn = null;
    previousStatus = null;

    await saveState(next);
  }

  function clearSession() {
    clearTimeout(cpuTimer);

    if (channel && sb) {
      sb.removeChannel(channel);
    }

    channel = null;
    room = null;
    selectedPublic = null;
    previousMyTurn = null;
    previousStatus = null;

    localStorage.removeItem('fiveLogicSession');
    localStorage.removeItem('fiveLogicCpuRoom');

    session = null;
    show(els.setup);
  }

  /* =========================
     Events
  ========================= */

  els.soundToggle.onclick = toggleSound;
  els.cpuStart.onclick = startCpuGame;
  els.create2.onclick = () => createOnlineRoom('online2');
  els.create3.onclick = () => createOnlineRoom('online3cpu');
  els.join.onclick = joinRoom;

  els.copyCode.onclick = async () => {
    try {
      await navigator.clipboard.writeText(session.code);
      toast('コードをコピーしました');
    } catch {
      toast(`部屋コード：${session.code}`);
    }
  };

  els.leave.onclick = clearSession;
  els.categorize.onclick = categorize;
  els.compare.onclick = openCompare;
  els.gotFive.onclick = openGuess;

  els.modalClose.onclick = () =>
    els.modal.classList.add('hidden');

  els.modal.onclick = event => {
    if (event.target === els.modal) {
      els.modal.classList.add('hidden');
    }
  };

  els.resetNotes.onclick = () => {
    localStorage.removeItem(notesKey());
    renderDeduction();
  };

  els.newGame.onclick = rematch;
  els.backHome.onclick = clearSession;

  /* =========================
     Start
  ========================= */

  if (session) {
    connectRoom();
  } else {
    show(els.setup);
  }
})();
