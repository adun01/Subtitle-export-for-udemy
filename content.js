(function () {
  "use strict";

  // =====================================================
  // CONFIG
  // =====================================================
  const VTT_WAIT_MS = 8000;
  const NAV_DELAY_MS = 3000;
  const SCAN_RETRY_MS = 3000;
  const MAX_RETRIES = 5;

  // =====================================================
  // STATE
  // =====================================================
  let courseId = null;
  let courseSlug = "";
  let curriculum = [];
  let targetLessons = [];
  let isRunning = false;
  let currentIdx = 0;
  let retryCount = 0;

  // =====================================================
  // COURSE DETECTION
  // =====================================================
  function detectCourseSlug() {
    const m = location.pathname.match(/\/course\/([^/]+)\//);
    return m ? m[1] : null;
  }

  function getCoursePath() {
    return `/course/${courseSlug}/learn`;
  }

  // =====================================================
  // STORAGE (per-course)
  // =====================================================
  const storageGet = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
  const storageSet = (data) => new Promise(r => chrome.storage.local.set(data, r));

  function sKey(name) { return `se_${courseSlug}_${name}`; }

  async function loadState() {
    const keys = [sKey("subs"), sKey("curriculum"), sKey("currentIdx"), sKey("isRunning"), sKey("courseId")];
    const data = await storageGet(keys);
    if (data[sKey("courseId")]) courseId = data[sKey("courseId")];
    if (data[sKey("curriculum")]?.length > 0) {
      curriculum = data[sKey("curriculum")];
      targetLessons = curriculum;
    }
    if (typeof data[sKey("currentIdx")] === "number") currentIdx = data[sKey("currentIdx")];
    return data;
  }

  async function saveProgress() {
    await storageSet({ [sKey("currentIdx")]: currentIdx, [sKey("isRunning")]: isRunning });
  }

  async function getSubs() {
    return (await storageGet([sKey("subs")]))[sKey("subs")] || {};
  }

  async function saveSub(lectureId, title, vttContent, url) {
    const subs = await getSubs();
    subs[`lec_${lectureId}`] = { title, lectureId, content: vttContent, url, timestamp: new Date().toISOString() };
    await storageSet({ [sKey("subs")]: subs });
    return Object.keys(subs).length;
  }

  // =====================================================
  // CURRICULUM
  // =====================================================
  async function detectCourseId() {
    try {
      const bodyText = document.body.innerHTML;
      const m = bodyText.match(/"courseId"\s*:\s*(\d+)/);
      if (m) return parseInt(m[1]);
    } catch (e) {}

    try {
      const resp = await fetch(
        `https://www.udemy.com/api-2.0/courses/${courseSlug}/?fields[course]=id`,
        { credentials: "include" }
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data.id) return data.id;
      }
    } catch (e) {}

    try {
      const resources = performance.getEntriesByType("resource");
      for (const r of resources) {
        const m = r.name.match(/courses\/(\d+)\//);
        if (m) return parseInt(m[1]);
      }
    } catch (e) {}

    return null;
  }

  async function fetchCurriculum() {
    setLoadingText("Loading course curriculum...");

    if (!courseId) {
      courseId = await detectCourseId();
      if (!courseId) {
        setLoadingText("Could not detect course ID. Try refreshing.");
        return false;
      }
      await storageSet({ [sKey("courseId")]: courseId });
    }

    let allItems = [], page = 1, hasMore = true;

    while (hasMore) {
      try {
        const resp = await fetch(
          `https://www.udemy.com/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=200&page=${page}&fields[lecture]=title,id&fields[chapter]=title,sort_order`,
          { credentials: "include" }
        );
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        const data = await resp.json();
        allItems = allItems.concat(data.results || []);
        hasMore = !!data.next;
        page++;
      } catch (e) {
        setLoadingText(`API error: ${e.message}`);
        return false;
      }
    }

    curriculum = [];
    let sectionIdx = 0, sectionTitle = "";
    for (const item of allItems) {
      if (item._class === "chapter") {
        sectionIdx++;
        sectionTitle = item.title || "";
      } else if (item._class === "lecture") {
        curriculum.push({ id: item.id, title: item.title, sectionIdx, sectionTitle });
      }
    }

    targetLessons = curriculum;
    await storageSet({ [sKey("curriculum")]: curriculum });
    return true;
  }

  // =====================================================
  // VTT SCAN
  // =====================================================
  async function scanForVTT() {
    const resources = performance.getEntriesByType("resource")
      .filter(r => r.name.includes(".vtt") && !r.name.includes("thumb-sprites"));
    for (const r of resources) {
      try {
        const resp = await fetch(r.name);
        const text = await resp.text();
        if (text.includes("WEBVTT") && text.length > 100) return text;
      } catch (e) {}
    }
    return null;
  }

  // =====================================================
  // NAVIGATION
  // =====================================================
  function getCurrentLectureId() {
    const m = location.pathname.match(/lecture\/(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  function navigateToLecture(lectureId) {
    window.location.href = `${getCoursePath()}/lecture/${lectureId}`;
  }

  // =====================================================
  // CRAWL LOOP
  // =====================================================
  async function processCurrentLesson() {
    if (!isRunning || currentIdx >= targetLessons.length) {
      if (currentIdx >= targetLessons.length) {
        isRunning = false;
        await saveProgress();
        logPanel("🎉 All lessons processed!", "success");
        updateUI();
      }
      return;
    }

    const lesson = targetLessons[currentIdx];
    const subs = await getSubs();

    if (subs[`lec_${lesson.id}`]) {
      logPanel(`⏭ ${currentIdx + 1}/${targetLessons.length} — "${lesson.title}" already saved`, "skip");
      currentIdx++;
      await saveProgress();
      updateUI();
      setTimeout(processCurrentLesson, 200);
      return;
    }

    const currentLid = getCurrentLectureId();
    if (currentLid !== lesson.id) {
      logPanel(`🔄 ${currentIdx + 1}/${targetLessons.length} — Navigating to "${lesson.title}"...`, "info");
      await saveProgress();
      navigateToLecture(lesson.id);
      return;
    }

    logPanel(`🔍 ${currentIdx + 1}/${targetLessons.length} — Scanning "${lesson.title}"...`, "info");

    const vtt = await scanForVTT();
    if (vtt) {
      const count = await saveSub(lesson.id, lesson.title, vtt, location.href);
      logPanel(`✅ ${currentIdx + 1}/${targetLessons.length} — "${lesson.title}" [${count} total]`, "success");
      retryCount = 0;
      currentIdx++;
      await saveProgress();
      updateUI();
      setTimeout(processCurrentLesson, NAV_DELAY_MS);
    } else {
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        logPanel(`⏳ VTT not found, attempt ${retryCount}/${MAX_RETRIES}...`, "info");
        setTimeout(processCurrentLesson, SCAN_RETRY_MS);
      } else {
        logPanel(`⚠️ "${lesson.title}" — no subtitles found, skipping`, "error");
        retryCount = 0;
        currentIdx++;
        await saveProgress();
        updateUI();
        setTimeout(processCurrentLesson, NAV_DELAY_MS);
      }
    }
  }

  async function startFromIndex(idx) {
    if (curriculum.length === 0) {
      const ok = await fetchCurriculum();
      if (!ok) return;
    }
    currentIdx = idx;
    retryCount = 0;
    isRunning = true;
    await saveProgress();
    logPanel(`▶ Starting from lesson ${idx + 1}: "${targetLessons[idx]?.title}"`, "info");
    updateUI();
    processCurrentLesson();
  }

  // =====================================================
  // UI — PANEL (starts in loading state)
  // =====================================================
  function createPanel() {
    if (document.getElementById("vtt-panel")) return;

    const panel = document.createElement("div");
    panel.id = "vtt-panel";
    panel.innerHTML = `
      <div id="vtt-header">
        <div style="display:flex;align-items:center">
          <span id="vtt-header-title">Subtitle Export</span>
          <span id="vtt-header-badge"></span>
        </div>
        <div id="vtt-header-btns">
          <button id="vtt-btn-min" title="Minimize">−</button>
        </div>
      </div>
      <div id="vtt-body">
        <div id="vtt-loading">
          <div class="vtt-spinner"></div>
          <div id="vtt-loading-text">Loading course data...</div>
        </div>
        <div id="vtt-ready" style="display:none">
          <div id="vtt-status">
            <div id="vtt-status-text">Ready</div>
            <div id="vtt-progress-bar"><div id="vtt-progress-fill"></div></div>
          </div>
          <div id="vtt-controls">
            <button id="vtt-btn-start">▶ Start</button>
            <button id="vtt-btn-continue">⏩ Continue</button>
            <button id="vtt-btn-stop" disabled>⏹ Stop</button>
            <button id="vtt-btn-download">💾 Export</button>
            <button id="vtt-btn-reset">🗑 Reset</button>
          </div>
          <div id="vtt-lesson-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    makeDraggable(panel, document.getElementById("vtt-header"));

    document.getElementById("vtt-btn-min").addEventListener("click", () => {
      panel.classList.toggle("minimized");
      document.getElementById("vtt-btn-min").textContent = panel.classList.contains("minimized") ? "+" : "−";
    });

    document.getElementById("vtt-btn-start").addEventListener("click", async () => {
      if (!confirm("Start collecting subtitles from the beginning?")) return;
      if (curriculum.length === 0) { if (!(await fetchCurriculum())) return; }
      currentIdx = 0;
      retryCount = 0;
      isRunning = true;
      await saveProgress();
      updateUI();
      processCurrentLesson();
    });

    document.getElementById("vtt-btn-continue").addEventListener("click", async () => {
      if (curriculum.length === 0) { if (!(await fetchCurriculum())) return; }
      retryCount = 0;
      isRunning = true;
      await saveProgress();
      updateUI();
      processCurrentLesson();
    });

    document.getElementById("vtt-btn-stop").addEventListener("click", async () => {
      isRunning = false;
      await saveProgress();
      logPanel("⏸ Stopped", "info");
      updateUI();
    });

    document.getElementById("vtt-btn-download").addEventListener("click", downloadAll);

    document.getElementById("vtt-btn-reset").addEventListener("click", async () => {
      if (!confirm("Delete ALL collected subtitles for this course?")) return;
      await storageSet({ [sKey("subs")]: {}, [sKey("currentIdx")]: 0, [sKey("isRunning")]: false });
      currentIdx = 0;
      isRunning = false;
      logPanel("🗑 All data cleared", "info");
      updateUI();
    });
  }

  // =====================================================
  // UI — LOADING / READY
  // =====================================================
  function setLoadingText(text) {
    const el = document.getElementById("vtt-loading-text");
    if (el) el.textContent = text;
    console.log(`[SubExport] ${text}`);
  }

  function showReady() {
    const loading = document.getElementById("vtt-loading");
    const ready = document.getElementById("vtt-ready");
    if (loading) loading.style.display = "none";
    if (ready) ready.style.display = "flex";
  }

  // =====================================================
  // UI — LESSON LIST
  // =====================================================
  async function renderLessonList() {
    const container = document.getElementById("vtt-lesson-list");
    if (!container) return;

    const subs = await getSubs();
    const currentLid = getCurrentLectureId();
    let html = "";
    let lastSection = -1;

    for (let i = 0; i < targetLessons.length; i++) {
      const lesson = targetLessons[i];
      const hasSub = !!subs[`lec_${lesson.id}`];
      const isCurrent = (i === currentIdx && isRunning);
      const isActivePage = (lesson.id === currentLid);

      if (lesson.sectionIdx !== lastSection) {
        lastSection = lesson.sectionIdx;
        const secTitle = lesson.sectionTitle || `Section ${lesson.sectionIdx}`;
        const secLessons = targetLessons.filter(l => l.sectionIdx === lesson.sectionIdx);
        const secDone = secLessons.filter(l => !!subs[`lec_${l.id}`]).length;
        html += `<div class="vtt-sec-hdr">
          <span>${secTitle}</span>
          <span class="cnt">${secDone}/${secLessons.length}</span>
        </div>`;
      }

      const classes = [
        "vtt-li",
        hasSub ? "done" : "",
        isCurrent ? "active" : "",
        isActivePage ? "active" : ""
      ].filter(Boolean).join(" ");

      html += `<div class="${classes}" data-idx="${i}" title="${lesson.title}">
        <span class="ck">${hasSub ? "✓" : (isCurrent ? "⟳" : "")}</span>
        <span class="nm">${i + 1}</span>
        <span class="tt">${lesson.title}</span>
        <button class="go" data-idx="${i}">▶</button>
      </div>`;
    }

    container.innerHTML = html;

    container.querySelectorAll(".vtt-li").forEach(el => {
      el.addEventListener("click", async (e) => {
        if (e.target.classList.contains("go")) return;
        const idx = parseInt(el.dataset.idx);
        currentIdx = idx;
        await saveProgress();
        logPanel(`📍 Position set: ${idx + 1} — "${targetLessons[idx].title}"`, "info");
        updateUI();
      });
    });

    container.querySelectorAll(".go").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        startFromIndex(parseInt(btn.dataset.idx));
      });
    });

    const activeEl = container.querySelector(".active") || container.querySelector(`[data-idx="${currentIdx}"]`);
    if (activeEl) activeEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function logPanel(message, type = "info") {
    const status = document.getElementById("vtt-status-text");
    if (status) status.textContent = message;
    console.log(`[SubExport] ${message}`);
  }

  async function updateUI() {
    const subs = await getSubs();
    const count = Object.keys(subs).length;
    const total = targetLessons.length || "?";

    const badge = document.getElementById("vtt-header-badge");
    if (badge) badge.textContent = `${count}/${total}`;

    const fill = document.getElementById("vtt-progress-fill");
    if (fill && targetLessons.length > 0) fill.style.width = `${(count / targetLessons.length) * 100}%`;

    const status = document.getElementById("vtt-status-text");
    if (status) {
      if (isRunning) {
        status.textContent = `⚡ Running — ${currentIdx + 1}/${total} (${count} collected)`;
      } else if (count >= targetLessons.length && targetLessons.length > 0) {
        status.textContent = `🎉 Done! ${count}/${total} collected`;
      } else {
        status.textContent = `⏸ ${count}/${total} collected, position: ${currentIdx + 1}`;
      }
    }

    const btnStart = document.getElementById("vtt-btn-start");
    const btnCont = document.getElementById("vtt-btn-continue");
    const btnStop = document.getElementById("vtt-btn-stop");
    const btnDl = document.getElementById("vtt-btn-download");
    if (btnStart) btnStart.disabled = isRunning;
    if (btnCont) btnCont.disabled = isRunning;
    if (btnStop) btnStop.disabled = !isRunning;
    if (btnDl) btnDl.disabled = count === 0;

    await renderLessonList();

    try { chrome.runtime.sendMessage({ type: "updateBadge", count }); } catch (e) {}
  }

  // =====================================================
  // DOWNLOAD
  // =====================================================
  async function downloadAll() {
    const subs = await getSubs();
    const entries = Object.values(subs);
    if (entries.length === 0) { logPanel("Nothing to export", "error"); return; }

    const idOrder = {};
    targetLessons.forEach((l, i) => { idOrder[l.id] = i; });
    entries.sort((a, b) => (idOrder[a.lectureId] ?? 999) - (idOrder[b.lectureId] ?? 999));

    let text = "";
    for (const entry of entries) {
      text += `\n${"=".repeat(60)}\n`;
      text += `${entry.title}\n`;
      text += `${"=".repeat(60)}\n\n`;
      text += entry.content;
      text += "\n";
    }

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${courseSlug}_subtitles_${entries.length}_lessons.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    logPanel(`💾 Exported ${entries.length} lessons`, "success");
  }

  // =====================================================
  // DRAG
  // =====================================================
  function makeDraggable(panel, handle) {
    let dragging = false, sx, sy, ox, oy;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = (ox + e.clientX - sx) + "px";
      panel.style.top = (oy + e.clientY - sy) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  // =====================================================
  // INIT
  // =====================================================
  async function init() {
    courseSlug = detectCourseSlug();
    if (!courseSlug) {
      console.log("[SubExport] Not on a Udemy course page");
      return;
    }

    // 1. Show panel in loading state immediately
    createPanel();

    // 2. Load saved state from storage
    const data = await loadState();
    const wasRunning = data[sKey("isRunning")];

    if (wasRunning) {
      isRunning = true;
      setLoadingText("Resuming...");
    }

    // 3. Fetch curriculum if not in cache
    if (curriculum.length === 0) {
      const ok = await fetchCurriculum();
      if (!ok) return; // stays on loading screen with error
    }

    // 4. Switch to ready UI
    showReady();
    await updateUI();

    // 5. Resume crawl if was running
    if (wasRunning) {
      setTimeout(processCurrentLesson, 2000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "triggerDownload") { downloadAll(); sendResponse({ ok: true }); }
  });

  if (document.readyState === "complete") setTimeout(init, 500);
  else window.addEventListener("load", () => setTimeout(init, 500));
})();
