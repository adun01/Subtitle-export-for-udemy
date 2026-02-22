(function () {
  "use strict";

  // =====================================================
  // CONFIG
  // =====================================================
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

  async function saveSub(lectureId, title, content, url, contentType = "vtt") {
    const subs = await getSubs();
    subs[`lec_${lectureId}`] = {
      title,
      lectureId,
      content,
      url,
      contentType,
      timestamp: new Date().toISOString()
    };
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
  // CONTENT DETECTION & EXTRACTION
  // =====================================================

  function isArticlePage() {
    return !!document.querySelector(".text-viewer--container--TFOCA, .article-asset--content--H92b2");
  }

  function extractArticleText() {
    const container = document.querySelector(".article-asset--content--H92b2");
    if (!container) return null;

    let text = "";

    const heading = document.querySelector(".text-viewer--main-heading--pPafb");
    if (heading) {
      text += heading.textContent.trim() + "\n\n";
    }

    const processNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) text += t + " ";
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();

      if (tag === "p") {
        text += "\n";
        node.childNodes.forEach(processNode);
        text += "\n";
      } else if (tag === "br") {
        text += "\n";
      } else if (tag === "strong" || tag === "b") {
        node.childNodes.forEach(processNode);
      } else if (tag === "em" || tag === "i") {
        node.childNodes.forEach(processNode);
      } else if (tag === "img") {
        const src = node.getAttribute("src");
        if (src) text += `\n[IMAGE: ${src}]\n`;
      } else if (tag === "figure") {
        node.childNodes.forEach(processNode);
      } else if (tag === "ul" || tag === "ol") {
        text += "\n";
        node.querySelectorAll("li").forEach((li, i) => {
          text += `  ${tag === "ol" ? (i + 1) + "." : "•"} ${li.textContent.trim()}\n`;
        });
        text += "\n";
      } else if (tag === "pre" || tag === "code") {
        text += "\n```\n" + node.textContent + "\n```\n";
      } else if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
        text += "\n\n" + node.textContent.trim() + "\n\n";
      } else {
        node.childNodes.forEach(processNode);
      }
    };

    container.childNodes.forEach(processNode);
    text = text.replace(/\n{3,}/g, "\n\n").trim();

    return text;
  }

  function extractArticleHTML() {
    const container = document.querySelector(".article-asset--content--H92b2");
    if (!container) return null;

    let html = "";

    const heading = document.querySelector(".text-viewer--main-heading--pPafb");
    if (heading) {
      html += `<h1>${heading.textContent.trim()}</h1>\n`;
    }

    html += container.innerHTML;
    html = html.replace(/class="[^"]*"/g, "");
    html = html.replace(/data-[^=]+="[^"]*"/g, "");
    html = html.replace(/\s+>/g, ">");

    return html;
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

    // Check if this is an article page
    if (isArticlePage()) {
      const articleText = extractArticleText();
      const articleHTML = extractArticleHTML();

      if (articleText && articleText.length > 50) {
        const content = JSON.stringify({ text: articleText, html: articleHTML });
        const count = await saveSub(lesson.id, lesson.title, content, location.href, "article");
        logPanel(`📄 ${currentIdx + 1}/${targetLessons.length} — "${lesson.title}" [article, ${count} total]`, "success");
        retryCount = 0;
        currentIdx++;
        await saveProgress();
        updateUI();
        setTimeout(processCurrentLesson, NAV_DELAY_MS);
        return;
      }
    }

    // Try to find VTT subtitles (for video lessons)
    const vtt = await scanForVTT();
    if (vtt) {
      const count = await saveSub(lesson.id, lesson.title, vtt, location.href, "vtt");
      logPanel(`✅ ${currentIdx + 1}/${targetLessons.length} — "${lesson.title}" [${count} total]`, "success");
      retryCount = 0;
      currentIdx++;
      await saveProgress();
      updateUI();
      setTimeout(processCurrentLesson, NAV_DELAY_MS);
    } else {
      retryCount++;
      if (retryCount < MAX_RETRIES) {
        logPanel(`⏳ Content not found, attempt ${retryCount}/${MAX_RETRIES}...`, "info");
        setTimeout(processCurrentLesson, SCAN_RETRY_MS);
      } else {
        logPanel(`⚠️ "${lesson.title}" — no content found, skipping`, "error");
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
  // UI — PANEL
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
            <button id="vtt-btn-download" title="Export as TXT">💾 TXT</button>
            <button id="vtt-btn-download-html" title="Export as HTML">🌐 HTML</button>
            <button id="vtt-btn-reset">🗑</button>
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
      if (!confirm("Start collecting from the beginning?")) return;
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

    document.getElementById("vtt-btn-download").addEventListener("click", () => downloadAll("txt"));
    document.getElementById("vtt-btn-download-html").addEventListener("click", () => downloadAll("html"));

    document.getElementById("vtt-btn-reset").addEventListener("click", async () => {
      if (!confirm("Delete ALL collected content for this course?")) return;
      await storageSet({ [sKey("subs")]: {}, [sKey("currentIdx")]: 0, [sKey("isRunning")]: false });
      currentIdx = 0;
      isRunning = false;
      logPanel("🗑 All data cleared", "info");
      updateUI();
    });
  }

  // =====================================================
  // UI HELPERS
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

  function logPanel(message, type = "info") {
    const status = document.getElementById("vtt-status-text");
    if (status) status.textContent = message;
    console.log(`[SubExport] ${message}`);
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
      const sub = subs[`lec_${lesson.id}`];
      const hasSub = !!sub;
      const isArticle = sub?.contentType === "article";
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

      const icon = hasSub ? (isArticle ? "📄" : "✓") : (isCurrent ? "⟳" : "");

      html += `<div class="${classes}" data-idx="${i}" title="${lesson.title}">
        <span class="ck">${icon}</span>
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
    const btnDlHtml = document.getElementById("vtt-btn-download-html");
    if (btnStart) btnStart.disabled = isRunning;
    if (btnCont) btnCont.disabled = isRunning;
    if (btnStop) btnStop.disabled = !isRunning;
    if (btnDl) btnDl.disabled = count === 0;
    if (btnDlHtml) btnDlHtml.disabled = count === 0;

    await renderLessonList();

    try { chrome.runtime.sendMessage({ type: "updateBadge", count }); } catch (e) {}
  }

  // =====================================================
  // DOWNLOAD
  // =====================================================
  async function downloadAll(format = "txt") {
    const subs = await getSubs();
    const entries = Object.values(subs);
    if (entries.length === 0) { logPanel("Nothing to export", "error"); return; }

    const idOrder = {};
    targetLessons.forEach((l, i) => { idOrder[l.id] = i; });
    entries.sort((a, b) => (idOrder[a.lectureId] ?? 999) - (idOrder[b.lectureId] ?? 999));

    if (format === "html") {
      downloadAsHTML(entries);
    } else {
      downloadAsTXT(entries);
    }
  }

  function downloadAsTXT(entries) {
    let text = "";
    for (const entry of entries) {
      text += `\n${"=".repeat(60)}\n`;
      text += `${entry.title}\n`;
      text += `${"=".repeat(60)}\n\n`;

      if (entry.contentType === "article") {
        try {
          const parsed = JSON.parse(entry.content);
          text += parsed.text || entry.content;
        } catch (e) {
          text += entry.content;
        }
      } else {
        text += entry.content;
      }
      text += "\n";
    }

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${courseSlug}_content_${entries.length}_lessons.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    logPanel(`💾 Exported ${entries.length} lessons as TXT`, "success");
  }

  function downloadAsHTML(entries) {
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${courseSlug} - Course Content</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.7;
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    h1 { color: #00ff88; border-bottom: 2px solid #00ff88; padding-bottom: 10px; }
    h2 { color: #58a6ff; margin-top: 60px; padding: 15px; background: #21262d; border-radius: 8px; }
    .lesson { margin: 30px 0; padding: 25px; background: #161b22; border-radius: 12px; border: 1px solid #30363d; }
    .lesson-title { color: #00ff88; font-size: 1.3em; margin-bottom: 15px; }
    .lesson-type { font-size: 0.8em; color: #8b949e; margin-left: 10px; }
    .content { white-space: pre-wrap; }
    .article-content { white-space: normal; }
    .article-content p { margin: 1em 0; }
    .article-content img { max-width: 100%; height: auto; border-radius: 8px; margin: 15px 0; }
    .article-content strong { color: #ffa657; }
    code, pre { background: #21262d; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    pre { padding: 15px; overflow-x: auto; }
    .toc { background: #21262d; padding: 20px; border-radius: 8px; margin-bottom: 40px; }
    .toc a { color: #58a6ff; text-decoration: none; display: block; padding: 5px 0; }
    .toc a:hover { color: #00ff88; }
    .section-header { color: #8b949e; font-size: 0.9em; margin-top: 15px; margin-bottom: 5px; }
  </style>
</head>
<body>
  <h1>📚 ${courseSlug}</h1>
  <p style="color: #8b949e;">Exported ${entries.length} lessons • ${new Date().toLocaleDateString()}</p>
  
  <div class="toc">
    <strong>Table of Contents</strong>
`;

    let lastSection = "";
    entries.forEach((entry, i) => {
      const lesson = targetLessons.find(l => l.id === entry.lectureId);
      if (lesson && lesson.sectionTitle !== lastSection) {
        lastSection = lesson.sectionTitle;
        html += `    <div class="section-header">${lastSection}</div>\n`;
      }
      const icon = entry.contentType === "article" ? "📄" : "🎬";
      html += `    <a href="#lesson-${i}">${icon} ${entry.title}</a>\n`;
    });

    html += `  </div>\n\n`;

    lastSection = "";
    entries.forEach((entry, i) => {
      const lesson = targetLessons.find(l => l.id === entry.lectureId);

      if (lesson && lesson.sectionTitle !== lastSection) {
        lastSection = lesson.sectionTitle;
        html += `  <h2>📁 ${lastSection}</h2>\n`;
      }

      const typeLabel = entry.contentType === "article" ? "Article" : "Video";
      html += `  <div class="lesson" id="lesson-${i}">\n`;
      html += `    <div class="lesson-title">${entry.title}<span class="lesson-type">[${typeLabel}]</span></div>\n`;

      if (entry.contentType === "article") {
        try {
          const parsed = JSON.parse(entry.content);
          html += `    <div class="article-content">${parsed.html || escapeHtml(parsed.text)}</div>\n`;
        } catch (e) {
          html += `    <div class="content">${escapeHtml(entry.content)}</div>\n`;
        }
      } else {
        const cleanVtt = cleanVTTContent(entry.content);
        html += `    <div class="content">${escapeHtml(cleanVtt)}</div>\n`;
      }

      html += `  </div>\n\n`;
    });

    html += `</body>\n</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${courseSlug}_content_${entries.length}_lessons.html`;
    a.click();
    URL.revokeObjectURL(a.href);
    logPanel(`🌐 Exported ${entries.length} lessons as HTML`, "success");
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function cleanVTTContent(vtt) {
    return vtt
      .replace(/^WEBVTT\s*/, "")
      .replace(/\d+\n\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*\n?/g, "")
      .replace(/^\d+\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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

    createPanel();

    const data = await loadState();
    const wasRunning = data[sKey("isRunning")];

    if (wasRunning) {
      isRunning = true;
      setLoadingText("Resuming...");
    }

    if (curriculum.length === 0) {
      const ok = await fetchCurriculum();
      if (!ok) return;
    }

    showReady();
    await updateUI();

    if (wasRunning) {
      setTimeout(processCurrentLesson, 2000);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "triggerDownload") { downloadAll("txt"); sendResponse({ ok: true }); }
  });

  if (document.readyState === "complete") setTimeout(init, 500);
  else window.addEventListener("load", () => setTimeout(init, 500));
})();