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
    myInsertLane: $('myInsertLane'),
    myHand: $('myHand'),
    myHandHint: $('myHandHint'),
    guessRow: $('guessRow'),
    publicTiles: $('publicTiles'),
    phaseText: $('phaseText'),

    drawPiles: $('drawPiles'),
    actionBar: $('actionBar'),
    selectedTileView: $('selectedTileView'),
    categorize: $('categorizeBtn'),
    compare: $('compareBtn'),
    cancelSelect: $('cancelSelectBtn'),

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
  let compareMode = false;
  let cpuTimer = null;
  let previousMyTurn = null;
  let previousStatus = null;
  let autoSkipRevision = null;
  let lastScrollKey = null;
  let lastRenderedClueCount = 0;

  // 自分の手番になった／段階が変わった時に、次に触る場所（山 or 場）を画面内へ寄せる。
  function maybeAutoScrollToAction(myTurn, gameOver, eliminated) {
    if (gameOver || eliminated || !myTurn || !room) {
      lastScrollKey = null;
      return;
    }

    const key = `${room.turn}:${room.phase}:${selectedPublic || ''}`;
    if (key === lastScrollKey) return;
    lastScrollKey = key;

    const target = room.phase === 'draw' ? els.drawPiles : els.publicTiles;

    requestAnimationFrame(() => {
      if (target) target.scrollIntoView({ block: 'center', behavior: 'auto' });
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
    compareMode = false;

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
          compareMode = false;
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

  // そのプレイヤーの列に「差し込まれたコマ」を、実際に差し込まれる位置へ置いて描画する。
  //   分類 → 5枚の“隙間”(0〜5)の位置に差し込む
  //   比較 → 比べた1枚の真上に「=」「≠」付きで置く
  // 同じ場所に複数ある場合は、列から遠ざかる向きに積み上げる。
  function renderInsertLane(container, playerIndex, options = {}) {
    const { below = false, compact = false, animateLatest = false } = options;

    const clues = room.clues.filter(c => c.by === playerIndex);
    const latest = room.clues[room.clues.length - 1];

    container.className =
      'insert-lane' + (below ? ' below' : '') + (compact ? ' compact' : '');
    container.innerHTML = '';

    if (!clues.length) {
      container.classList.add('empty');
      container.innerHTML =
        '<div class="insert-empty">まだ差し込まれたコマはありません</div>';
      container.style.height = '';
      return;
    }

    const stacks = new Map();

    clues.forEach(clue => {
      const key = clue.type === 'categorize' ? `g${clue.slot}` : `p${clue.pos}`;
      if (!stacks.has(key)) stacks.set(key, []);
      stacks.get(key).push(clue);
    });

    stacks.forEach(list => list.sort((a, b) => a.tile - b.tile));

    // 立てたコマと寝かせたコマで高さが違うので、下のコマの数字が隠れない分だけ
    // ずらして積む。レーンの高さは一番高い山に合わせる。
    const upHeight = compact ? 29 : 34;
    const sideHeight = compact ? 22 : 26;
    const upStep = compact ? 18 : 22;
    const sideStep = compact ? 15 : 18;
    const isSideways = clue => clue.type === 'compare' && !clue.yes;

    let laneHeight = compact ? 32 : 38;

    stacks.forEach(list => {
      let top = 0;
      list.forEach((clue, i) => {
        const h = isSideways(clue) ? sideHeight : upHeight;
        if (i === list.length - 1) laneHeight = Math.max(laneHeight, top + h + 4);
        top += isSideways(clue) ? sideStep : upStep;
      });
    });

    container.style.height = `${laneHeight}px`;

    stacks.forEach((list, key) => {
      const isGap = key[0] === 'g';
      const index = Number(key.slice(1));

      const stack = document.createElement('div');
      stack.className = 'insert-stack';

      // ラックの5列と同じグリッド上で、隙間なら列の端、比較なら列の中央に寄せる。
      if (isGap) {
        if (index === 0) {
          stack.style.gridColumn = '1';
          stack.classList.add('edge-start');
        } else {
          stack.style.gridColumn = String(index);
          stack.classList.add(index === 5 ? 'edge-end' : 'edge-between');
        }
      } else {
        stack.style.gridColumn = String(index + 1);
      }

      let offset = 0;

      list.forEach(clue => {
        const t = tileByN(clue.tile);
        const chip = document.createElement('div');

        // ドットが違った比較は、実物と同じように横向きに寝かせて置く。
        const sideways = isSideways(clue);

        chip.className =
          'insert-chip ' + t.color + (isGap ? ' as-gap' : ' as-pos') +
          (sideways ? ' sideways' : '') +
          (animateLatest && clue === latest ? ' just-placed' : '');

        chip.style[below ? 'top' : 'bottom'] = `${offset}px`;
        offset += sideways ? sideStep : upStep;

        chip.innerHTML = `
          <span class="chip-num">${clue.tile}</span>
          <span class="chip-dots">${'●'.repeat(t.dots)}</span>
          ${isGap ? '' : `<span class="chip-mark ${clue.yes ? 'same' : 'diff'}">${clue.yes ? '=' : '≠'}</span>`}
        `;

        stack.appendChild(chip);
      });

      container.appendChild(stack);
    });
  }

  function renderOpponents(gameOver, animateLatest) {
    const meIndex = humanIndex();

    const opponents = room.players
      .map((p, i) => ({ p, i }))
      .filter(x => x.p && x.i !== meIndex);

    els.opponentsArea.innerHTML = opponents.map(({ p, i }) => {
      const isCpu = i === cpuIndex();
      const stateClass = p.eliminated ? 'out' : isCpu ? 'cpu' : '';
      const stateText = p.eliminated ? '脱落' : isCpu ? 'CPU' : '対戦相手';
      const isTurn = !gameOver && room.status === 'playing' && room.turn === i;

      return `
        <section class="board-section opponent-board ${p.eliminated ? 'eliminated' : ''} ${isTurn ? 'active-turn' : ''}">
          <div class="section-title-row">
            <h2>${escapeHtml(p.name)} のコマ</h2>
            <span class="player-state ${stateClass}">${stateText}</span>
          </div>
          <div class="rack opponent-rack">
            ${p.hand.map(n => tileHTML(n, false)).join('')}
          </div>
          <div class="insert-lane below compact" data-lane-for="${i}"></div>
        </section>
      `;
    }).join('');

    opponents.forEach(({ i }) => {
      const lane = els.opponentsArea.querySelector(`[data-lane-for="${i}"]`);
      if (lane) {
        renderInsertLane(lane, i, { below: true, compact: true, animateLatest });
      }
    });
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

    // 新しい手がかりが増えた時だけ、差し込まれたコマを動かす演出を出す。
    const animateLatest = room.clues.length > lastRenderedClueCount;
    lastRenderedClueCount = room.clues.length;

    renderOpponents(gameOver, animateLatest);

    els.myHandHint.textContent =
      gameOver ? '最終公開' : '数字は秘密';

    renderInsertLane(els.myInsertLane, meIndex, { animateLatest });

    els.myHand.innerHTML =
      me.hand
        .map(n => tileHTML(n, !gameOver))
        .join('');

    // 比較のときは「1番目〜5番目」のボタンではなく、実際に自分のコマをタップして選ぶ。
    if (compareMode && myTurn && room.phase === 'clue') {
      [...els.myHand.querySelectorAll('.tile')].forEach((node, pos) => {
        node.classList.add('choosable');
        node.onclick = () => compareAt(pos);
      });
    }

    renderGuessRow(gameOver);

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
          compareMode = false;
          render();
          maybeAutoScrollToAction(myTurn, gameOver, me.eliminated);
        };
      });
    }

    renderDeduction();

    if (gameOver) {
      els.actionBar.classList.add('hidden');
      els.phaseText.textContent = '最終局面';
      els.gotFive.classList.add('hidden');
      renderDrawPiles(false);

      els.result.classList.remove('hidden');
      renderResult();
      return;
    }

    els.result.classList.add('hidden');

    if (me.eliminated) {
      els.actionBar.classList.add('hidden');
      els.gotFive.classList.add('hidden');
      els.phaseText.textContent = '観戦中';
      renderDrawPiles(false);
      return;
    }

    els.gotFive.classList.remove('hidden');
    renderActionState();
    maybeAutoScrollToAction(myTurn, gameOver, me.eliminated);
  }

  // 5色の山を「裏向きに積まれたコマ」として描画する。めくれる時だけ押せる。
  function renderDrawPiles(canDraw) {
    els.drawPiles.innerHTML = '';

    COLORS.forEach(c => {
      const left = room.remaining.filter(
        n => tileByN(n).color === c.key
      ).length;

      const pile = document.createElement('button');
      pile.className =
        `draw-pile ${c.key}` +
        (left === 0 ? ' empty' : '') +
        (canDraw && left > 0 ? ' ready' : '');
      pile.disabled = !canDraw || left === 0;
      pile.title = `${c.label} 残り${left}枚`;

      pile.innerHTML = `
        <span class="pile-face">${left === 0 ? '' : '★'}</span>
        <span class="pile-count">${left}</span>
      `;

      pile.onclick = () => drawTile(c.key);
      els.drawPiles.appendChild(pile);
    });
  }

  function renderActionState() {
    const meIndex = humanIndex();
    const me = room.players[meIndex];
    const myTurn =
      room.status === 'playing' &&
      !me.eliminated &&
      room.turn === meIndex;

    const canDraw = myTurn && room.phase === 'draw';
    const canClue = myTurn && room.phase === 'clue';

    renderDrawPiles(canDraw);

    els.actionBar.classList.toggle('hidden', !(canClue && selectedPublic));

    if (canClue && selectedPublic) {
      els.selectedTileView.innerHTML = tileHTML(selectedPublic);
    }

    els.myHand.classList.toggle('choosing', canClue && compareMode);

    if (!myTurn) {
      els.phaseText.textContent =
        room.turn === cpuIndex()
          ? 'CPUの操作中'
          : '相手の操作待ち';
    } else if (canDraw) {
      els.phaseText.textContent = '① 山から1枚めくる';
    } else if (compareMode) {
      els.phaseText.textContent = '③ 自分のコマをタップ';
    } else if (selectedPublic) {
      els.phaseText.textContent = '③ 差し込む か 比べる を選ぶ';
    } else {
      els.phaseText.textContent = '② 場のコマを1枚選ぶ';
    }
  }

  /* =========================
     数字メモ（自分の端末だけに保存）
  ========================= */

  function guessKey() {
    const dealId = room?.dealId || 'legacy';
    return `fiveLogicGuess:${session.code}:${session.token}:${dealId}`;
  }

  function getGuesses() {
    try {
      const raw = JSON.parse(localStorage.getItem(guessKey()) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (_) {
      return [];
    }
  }

  function saveGuesses(list) {
    try {
      localStorage.setItem(guessKey(), JSON.stringify(list));
    } catch (_) {
      /* 保存できなくてもゲームは続行する */
    }
  }

  // 位置ごとの色は自分にも見えている情報なので、色が合わない数字や
  // 昇順になっていない数字はその場で赤く知らせる。
  function validateGuessRow() {
    const inputs = [...els.guessRow.querySelectorAll('.guess-input')];
    const values = inputs.map(i => (i.value === '' ? null : Number(i.value)));

    inputs.forEach((input, pos) => {
      const v = values[pos];
      let bad = false;

      if (v !== null) {
        if (!Number.isInteger(v) || v < 1 || v > 60) {
          bad = true;
        } else if (tileByN(v).color !== input.dataset.color) {
          bad = true;
        } else {
          for (let k = 0; k < pos; k++) {
            if (values[k] !== null && values[k] >= v) bad = true;
          }
          for (let k = pos + 1; k < 5; k++) {
            if (values[k] !== null && values[k] <= v) bad = true;
          }
        }
      }

      input.classList.toggle('invalid', bad);
    });
  }

  function renderGuessRow(gameOver) {
    const me = room.players[humanIndex()];
    const saved = getGuesses();

    els.guessRow.innerHTML = '';

    me.hand.forEach((actualN, pos) => {
      const color = tileByN(actualN).color;
      const cell = document.createElement('div');
      cell.className = `guess-cell ${color}`;

      if (gameOver) {
        cell.classList.add('revealed');
        cell.textContent = actualN;
        els.guessRow.appendChild(cell);
        return;
      }

      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 2;
      input.className = 'guess-input';
      input.placeholder = '?';
      input.value = saved[pos] || '';
      input.dataset.color = color;

      input.oninput = () => {
        input.value = input.value.replace(/[^0-9]/g, '').slice(0, 2);
        const list = getGuesses();
        list[pos] = input.value;
        saveGuesses(list);
        validateGuessRow();
      };

      cell.appendChild(input);
      els.guessRow.appendChild(cell);
    });

    if (!gameOver) validateGuessRow();
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

  // 「ドットを比べる」を押したら、自分のコマを実際にタップして相手を選ぶ。
  function openCompare() {
    if (!selectedPublic) return;

    compareMode = true;
    render();
    toast('比べたい自分のコマをタップしてください');

    requestAnimationFrame(() => {
      els.myHand.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }

  async function compareAt(pos) {
    if (!selectedPublic) return;

    compareMode = false;

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
    compareMode = false;
  }

  /* =========================
     Notes
  ========================= */

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

  // 宣言は、自分のコマの下にある「数字メモ」に書いた5つで行う。
  function openGuess() {
    const me = room.players[humanIndex()];

    if (me.eliminated || room.status !== 'playing') return;

    const values = [...els.guessRow.querySelectorAll('.guess-input')]
      .map(input => Number(input.value));

    if (values.length !== 5 || values.some(v => !Number.isInteger(v) || v < 1 || v > 60)) {
      toast('自分のコマの下に、5つの数字を書き込んでください');
      els.guessRow.scrollIntoView({ block: 'center', behavior: 'auto' });
      return;
    }

    const sorted = [...values].sort((a, b) => a - b);

    if (sorted.some((v, i) => v !== values[i])) {
      toast('左から小さい順になるように直してください');
      els.guessRow.scrollIntoView({ block: 'center', behavior: 'auto' });
      return;
    }

    els.modalTitle.textContent = 'GOT FIVE! を宣言しますか？';

    els.modalBody.innerHTML = `
      <p class="small">この5枚で宣言します。間違えると脱落します。</p>
      <div class="rack confirm-rack">
        ${values.map(n => tileHTML(n)).join('')}
      </div>
      <button id="submitGuess" class="danger wide">この5枚で宣言する</button>
    `;

    els.modal.classList.remove('hidden');
    $('submitGuess').onclick = () => submitGuess(values);
  }

  async function submitGuess(values) {
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
    compareMode = false;
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

  els.cancelSelect.onclick = () => {
    selectedPublic = null;
    compareMode = false;
    render();
  };

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
