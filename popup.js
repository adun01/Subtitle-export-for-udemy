document.addEventListener("DOMContentLoaded", async () => {
  // Find any stored course data
  const allData = await chrome.storage.local.get(null);
  
  // Find keys matching our pattern
  let totalSubs = 0;
  let currentCourse = null;
  
  for (const key of Object.keys(allData)) {
    if (key.match(/^se_.*_subs$/)) {
      const subs = allData[key] || {};
      const cnt = Object.keys(subs).length;
      if (cnt > totalSubs) {
        totalSubs = cnt;
        currentCourse = key.replace(/^se_/, "").replace(/_subs$/, "");
      }
    }
  }

  if (currentCourse) {
    const curriculum = allData[`se_${currentCourse}_curriculum`] || [];
    const idx = allData[`se_${currentCourse}_currentIdx`] || 0;
    const running = allData[`se_${currentCourse}_isRunning`] || false;
    const total = curriculum.length || "?";

    document.getElementById("count").textContent = `${totalSubs} / ${total}`;
    document.getElementById("pos").textContent = `${idx + 1} / ${total}`;
    document.getElementById("status").textContent = running ? "⚡ Running" : "⏸ Stopped";
  } else {
    document.getElementById("count").textContent = "0";
    document.getElementById("pos").textContent = "—";
    document.getElementById("status").textContent = "No course loaded";
  }

  const btnDl = document.getElementById("btn-dl");
  btnDl.disabled = totalSubs === 0;
  
  btnDl.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "triggerDownload" });
    }
  });
});
