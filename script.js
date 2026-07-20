(function () {
    "use strict";

    /* ============================================================
        0. 安全なストレージ層
    ============================================================ */
    const safeStorage = (function () {
        const memory = {};
        let usable = true;
        try {
            const testKey = "__storage_test__";
            window.localStorage.setItem(testKey, "1");
            window.localStorage.removeItem(testKey);
        } catch (e) {
            usable = false;
        }
        return {
            get(key) {
                if (usable) {
                    try { return window.localStorage.getItem(key); } catch (e) { /* fallthrough */ }
                }
                return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
            },
            set(key, value) {
                if (usable) {
                    try { window.localStorage.setItem(key, value); return; } catch (e) { /* fallthrough */ }
                }
                memory[key] = value;
            }
        };
    })();

    function loadJSON(key, fallback) {
        const raw = safeStorage.get(key);
        if (!raw) return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }
    function saveJSON(key, value) { safeStorage.set(key, JSON.stringify(value)); }
    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = String(str == null ? "" : str);
        return div.innerHTML;
    }

    /* ============================================================
        1. 状態管理
    ============================================================ */
    let currentMode = "pomodoro";
    let timerId = null;
    const timerRing = document.getElementById("timerRing");

    const pomoState = { running: false, currentLoop: 1, isBreak: false, duration: 0, startTime: 0, lastElapsedSeconds: 0 };
    const swState = { isRunning: false, startTime: 0, elapsedTime: 0, lastElapsedSeconds: 0, lastReminderMinutes: 0 };

    let pomoSettings = loadJSON("f_pomo_settings", { loops: 2, workMin: 25, breakMin: 5 });

    const defaultTags = [
        { id: "t1", name: "読書", color: "#ff7675" },
        { id: "t2", name: "学習", color: "#74b9ff" },
        { id: "t3", name: "仕事", color: "#55efc4" },
        { id: "t4", name: "その他", color: "#a29bfe" }
    ];
    let appTags = loadJSON("f_tags", defaultTags);
    if (!Array.isArray(appTags) || appTags.length === 0) appTags = defaultTags;
    let currentTagId = safeStorage.get("f_current_tag") || appTags[0].id;

    const tagColorPalette = ["#ff7675", "#74b9ff", "#55efc4", "#a29bfe", "#ffeaa7", "#fd79a8", "#81ecec", "#fab1a0"];
    let selectedNewTagColor = tagColorPalette[0];

    function formatDateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }
    function getTodayDateString() { return formatDateKey(new Date()); }

    function buildSeedWorkLog() { return {}; }
    let workLog = loadJSON("f_work_log", null) || buildSeedWorkLog();
    if (!loadJSON("f_work_log", null)) saveJSON("f_work_log", workLog);

    const now = new Date();
    let currentCalYear = now.getFullYear();
    let currentCalMonth = now.getMonth();
    let selectedCalDateString = getTodayDateString();
    let chartInstance = null;
    
    // ログ手動編集用の状態
    let editingLogDate = null;
    let editingLogTagId = null;

    const jpDayOfWeek = ["日", "月", "火", "水", "木", "金", "土"];

    /* ============================================================
        2. 汎用ヘルパー
    ============================================================ */
    function formatSecondsToJp(seconds) {
        if (!seconds || seconds <= 0) return "0分";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        let res = "";
        if (h > 0) res += `${h}時間 `;
        if (m > 0 || h > 0) res += `${m}分 `;
        res += `${s}秒`;
        return res;
    }

    function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

    function showToast(message) {
        const toast = document.getElementById("toastEl");
        toast.textContent = message;
        toast.classList.add("show");
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toast.classList.remove("show"), 2600);
    }

    function setIconState(btn, isPlaying) {
        const playIcon = btn.querySelector(".icon-play");
        const pauseIcon = btn.querySelector(".icon-pause");
        if (playIcon && pauseIcon) {
            playIcon.style.display = isPlaying ? "none" : "block";
            pauseIcon.style.display = isPlaying ? "block" : "none";
        }
    }

    /* ============================================================
        2.5 通知制御ヘルパー
    ============================================================ */
    async function ensureNotificationPermission() {
        if (!("Notification" in window)) return false;
        if (Notification.permission === "granted") return true;
        if (Notification.permission !== "denied") {
            const permission = await Notification.requestPermission();
            return permission === "granted";
        }
        return false;
    }

    async function showSWNotification(title, body, tag) {
        const permitted = await ensureNotificationPermission();
        if (!permitted) return;

        if ("serviceWorker" in navigator) {
            const reg = await navigator.serviceWorker.ready;
            reg.showNotification(title, {
                body: body,
                icon: 'https://placehold.co/192x192/171a26/74b9ff?text=FT',
                tag: tag,
                renotify: true,
                requireInteraction: true
            }).catch(() => {
                if (reg.active) {
                    reg.active.postMessage({ type: 'SHOW_NOTIFICATION', title, body, tag });
                }
            });
        }
    }

    async function clearSWNotification(tag) {
        if ("serviceWorker" in navigator && Notification.permission === "granted") {
            const reg = await navigator.serviceWorker.ready;
            const notifications = await reg.getNotifications({ tag: tag });
            notifications.forEach(n => n.close());
        }
    }

    /* ============================================================
        3. ドロワー / モーダル 共通制御
    ============================================================ */
    const overlay = document.getElementById("overlay");
    function openDrawer(id) {
        document.getElementById(id).classList.add("open");
        overlay.classList.add("active");
    }
    function openModal(id) {
        document.getElementById(id).classList.add("active");
        overlay.classList.add("active");
    }
    function closeAllOverlays() {
        document.querySelectorAll(".bottom-drawer").forEach(d => d.classList.remove("open"));
        document.querySelectorAll(".modal").forEach(m => m.classList.remove("active"));
        overlay.classList.remove("active");
    }
    document.querySelectorAll("[data-close]").forEach(btn => btn.addEventListener("click", closeAllOverlays));
    overlay.addEventListener("click", closeAllOverlays);

    /* ============================================================
        3.5 長時間放置 (Abandonment) 検知制御 (案A)
    ============================================================ */
    let isAbandonmentPromptOpen = false;
    let bgStartTime = 0;
    let bgStartLogSnapshot = null;
    const ABANDON_THRESHOLD = 2 * 60 * 60 * 1000; // 2時間をミリ秒で定義

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            bgStartTime = Date.now();
            bgStartLogSnapshot = JSON.stringify(workLog); 
        } else {
            if (bgStartTime > 0) {
                const bgDuration = Date.now() - bgStartTime;
                if (bgDuration >= ABANDON_THRESHOLD) {
                    if (swState.isRunning || pomoState.running) {
                        isAbandonmentPromptOpen = true;
                        clearInterval(timerId);
                        openModal("abandonmentModal");
                    }
                }
                bgStartTime = 0;
            }
        }
    });

    document.getElementById("abandonDiscardBtn").addEventListener("click", () => {
        if (bgStartLogSnapshot) {
            workLog = JSON.parse(bgStartLogSnapshot);
            saveJSON("f_work_log", workLog);
        }
        forceStopActiveTimers();
        closeAllOverlays();
        isAbandonmentPromptOpen = false;
        showToast("放置された時間を破棄しました");
    });

    document.getElementById("abandonSaveBtn").addEventListener("click", () => {
        if (bgStartLogSnapshot) {
            workLog = JSON.parse(bgStartLogSnapshot);
            const todayStr = getTodayDateString();
            if (!workLog[todayStr]) workLog[todayStr] = { total: 0, tags: {} };
            workLog[todayStr].total += 7200;
            workLog[todayStr].tags[currentTagId] = (workLog[todayStr].tags[currentTagId] || 0) + 7200;
            saveJSON("f_work_log", workLog);
        }
        forceStopActiveTimers();
        closeAllOverlays();
        isAbandonmentPromptOpen = false;
        showToast("2時間分のログを記録して停止しました");
    });

    function forceStopActiveTimers() {
        if (swState.isRunning) {
            swState.isRunning = false;
            setIconState(document.getElementById("swPlayBtn"), false);
            document.getElementById("sw-status-text").textContent = "一時停止中";
            swState.elapsedTime = bgStartTime - swState.startTime; 
            const totalMs = swState.elapsedTime;
            const hrs = Math.floor(totalMs / 3600000).toString().padStart(2, "0");
            const mins = Math.floor((totalMs % 3600000) / 60000).toString().padStart(2, "0");
            const secs = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
            document.getElementById("sw-time-text").textContent = `${hrs}:${mins}:${secs}`;
            updateSwRingStyle();
            clearSWNotification('timer-persistent');
        }
        if (pomoState.running) {
            stopPomodoro(); 
        }
        updateTabState();
    }

    /* ============================================================
        4. 作業ログ記録・修正機能
    ============================================================ */
    function logWorkSeconds(sec) {
        const todayStr = getTodayDateString();
        if (!workLog[todayStr]) workLog[todayStr] = { total: 0, tags: {} };
        workLog[todayStr].total += sec;
        workLog[todayStr].tags[currentTagId] = (workLog[todayStr].tags[currentTagId] || 0) + sec;
        saveJSON("f_work_log", workLog);

        if (document.getElementById("statsDrawer").classList.contains("open")) {
            renderCalendar(currentCalYear, currentCalMonth);
            if (selectedCalDateString === todayStr) updateSelectedDayDetail(todayStr);
            if (document.getElementById("chart-view-container").style.display !== "none") {
                renderChart(currentCalYear, currentCalMonth);
            }
        }
    }

    function openEditLogModal(dateString, tagId, currentMins) {
        editingLogDate = dateString;
        editingLogTagId = tagId;
        const tag = getTag(tagId);
        const [y, m, d] = dateString.split("-").map(Number);
        
        document.getElementById("editLogTargetText").textContent = `${y}年${m}月${d}日 ー #${tag ? tag.name : '不明'}`;
        document.getElementById("editLogMinutes").value = currentMins;
        openModal("editLogModal");
    }

    document.getElementById("saveEditLogBtn").addEventListener("click", () => {
        const newMins = parseInt(document.getElementById("editLogMinutes").value, 10);
        if (isNaN(newMins) || newMins < 0) {
            showToast("正しい分数を入力してください");
            return;
        }

        openConfirmModal("修正の確認", "入力した作業時間に修正しますか？", "修正する", false, () => {
            if (workLog[editingLogDate] && workLog[editingLogDate].tags) {
                const newSecs = newMins * 60;
                workLog[editingLogDate].tags[editingLogTagId] = newSecs;

                let newTotal = 0;
                for (const tId in workLog[editingLogDate].tags) {
                    newTotal += workLog[editingLogDate].tags[tId];
                }
                workLog[editingLogDate].total = newTotal;

                saveJSON("f_work_log", workLog);
                
                renderCalendar(currentCalYear, currentCalMonth);
                updateSelectedDayDetail(editingLogDate);
                if (document.getElementById("chart-view-container").style.display !== "none") {
                    renderChart(currentCalYear, currentCalMonth);
                }
                
                showToast("作業時間を修正しました");
            }
        });
    });

    /* ============================================================
        5. タグ管理
    ============================================================ */
    function getTag(id) { return appTags.find(t => t.id === id); }

    function fn_updateActiveTagDisplay() {
        const tag = getTag(currentTagId) || appTags[0];
        document.getElementById("activeTagDot").style.backgroundColor = tag.color;
        document.getElementById("activeTagText").textContent = `#${tag.name}`;
        timerRing.style.setProperty("--active-color", tag.color);
        if (currentMode === "pomodoro" && !pomoState.running) updatePomoGauge(0);
        if (currentMode === "stopwatch") updateSwRingStyle();
    }

    function openTagModal() {
        renderTagList();
        renderColorSwatches();
        openModal("tagSelectModal");
    }

    function renderTagList() {
        const container = document.getElementById("tagListContainer");
        container.innerHTML = "";
        appTags.forEach(tag => {
            const item = document.createElement("div");
            const isSelected = tag.id === currentTagId;
            item.className = `tag-item ${isSelected ? "selected" : ""}`;
            item.style.color = isSelected ? tag.color : "";
            item.style.backgroundColor = isSelected ? `${tag.color}26` : "";
            item.innerHTML = `
                <div class="tag-color-dot" style="background-color:${tag.color};"></div>
                <span style="color:#fff;">${escapeHtml(tag.name)}</span>
                <span class="tag-item-delete" data-del-tag="${tag.id}"><i data-lucide="x"></i></span>
            `;
            item.addEventListener("click", (e) => {
                if (e.target.closest("[data-del-tag]")) return;
                currentTagId = tag.id;
                safeStorage.set("f_current_tag", currentTagId);
                fn_updateActiveTagDisplay();
                renderTagList();
            });
            container.appendChild(item);
        });
        container.querySelectorAll("[data-del-tag]").forEach(el => {
            el.addEventListener("click", (e) => {
                e.stopPropagation();
                deleteTag(el.getAttribute("data-del-tag"));
            });
        });
        refreshIcons();
    }

    function deleteTag(id) {
        if (appTags.length <= 1) {
            showToast("タグは最低1つ残す必要があります。");
            return;
        }
        const tag = getTag(id);
        openConfirmModal("タグの削除", `タグ「#${tag ? tag.name : ""}」を削除してもよろしいですか？（過去の記録は残ります）`, "削除する", true, () => {
            appTags = appTags.filter(t => t.id !== id);
            saveJSON("f_tags", appTags);
            if (currentTagId === id) {
                currentTagId = appTags[0].id;
                safeStorage.set("f_current_tag", currentTagId);
                fn_updateActiveTagDisplay();
            }
            renderTagList();
            showToast("タグを削除しました");
        });
    }

    function renderColorSwatches() {
        const row = document.getElementById("colorSwatchRow");
        row.innerHTML = "";
        tagColorPalette.forEach(color => {
            const sw = document.createElement("div");
            sw.className = `color-swatch ${color === selectedNewTagColor ? "selected" : ""}`;
            sw.style.backgroundColor = color;
            sw.innerHTML = `<i data-lucide="check"></i>`;
            sw.addEventListener("click", () => {
                selectedNewTagColor = color;
                renderColorSwatches();
            });
            row.appendChild(sw);
        });
        refreshIcons();
    }

    function createNewTag() {
        const input = document.getElementById("new-tag-name");
        const name = input.value.trim();
        if (!name) { showToast("タグ名を入力してください"); return; }

        const newTag = { id: "t" + Date.now(), name, color: selectedNewTagColor };
        appTags.push(newTag);
        saveJSON("f_tags", appTags);

        currentTagId = newTag.id;
        safeStorage.set("f_current_tag", currentTagId);

        input.value = "";
        renderTagList();
        fn_updateActiveTagDisplay();
    }

    /* ============================================================
        6. モード切替とタブUIの制御
    ============================================================ */
    function updateTabState() {
        const isRunning = pomoState.running || swState.isRunning;
        const tabPomo = document.getElementById("tab-pomo");
        const tabSw = document.getElementById("tab-sw");
        
        tabPomo.classList.toggle("disabled", isRunning);
        tabPomo.disabled = isRunning; 
        
        tabSw.classList.toggle("disabled", isRunning);
        tabSw.disabled = isRunning; 
    }

    function updateSettingsBtnState() {
        document.getElementById("openSettingsBtn").classList.toggle("disabled", currentMode !== "pomodoro");
    }

    function switchMode(mode) {
        if (mode === currentMode) return;

        if (pomoState.running || swState.isRunning) {
            return;
        }

        currentMode = mode;
        document.getElementById("tab-pomo").classList.toggle("active", mode === "pomodoro");
        document.getElementById("tab-sw").classList.toggle("active", mode === "stopwatch");
        document.getElementById("content-pomodoro").classList.toggle("active", mode === "pomodoro");
        document.getElementById("content-stopwatch").classList.toggle("active", mode === "stopwatch");

        document.getElementById("pomoIdleControls").style.display = (mode === "pomodoro" && !pomoState.running) ? "flex" : "none";
        document.getElementById("pomoRunControls").style.display = (mode === "pomodoro" && pomoState.running) ? "flex" : "none";
        document.getElementById("swControlsGroup").style.display = (mode === "stopwatch") ? "flex" : "none";

        updateSettingsBtnState();
        if (mode === "pomodoro") { updatePomoGauge(0); } else { updateSwRingStyle(); }
    }

    /* ============================================================
        7. ステッパー操作
    ============================================================ */
    function adjustStepper(id, delta, min, max) {
        const el = document.getElementById(id);
        let next = parseInt(el.value, 10) + delta;
        if (next < min) next = min;
        if (next > max) next = max;
        el.value = next;
        syncPomoSettingsFromInputs();
    }

    function syncPomoSettingsFromInputs() {
        pomoSettings.loops = parseInt(document.getElementById("set-loops").value, 10) || 1;
        pomoSettings.workMin = parseInt(document.getElementById("set-work").value, 10) || 1;
        pomoSettings.breakMin = parseInt(document.getElementById("set-break").value, 10) || 1;
        saveJSON("f_pomo_settings", pomoSettings);
        if (!pomoState.running) updateIdlePomoDisplay();
    }

    function loadPomoSettingsIntoInputs() {
        document.getElementById("set-loops").value = pomoSettings.loops;
        document.getElementById("set-work").value = pomoSettings.workMin;
        document.getElementById("set-break").value = pomoSettings.breakMin;
    }

    /* ============================================================
        8. ポモドーロタイマー
    ============================================================ */
    function updateIdlePomoDisplay() {
        const m = String(pomoSettings.workMin).padStart(2, "0");
        document.getElementById("pomo-time-text").textContent = `${m}:00`;
        document.getElementById("pomo-status-text").textContent =
            `作業${pomoSettings.workMin}分・休憩${pomoSettings.breakMin}分 × ${pomoSettings.loops}セット`;
    }

    async function startPomodoro() {
        pomoState.running = true;
        pomoState.currentLoop = 1;
        pomoState.isBreak = false;
        pomoState.duration = pomoSettings.workMin * 60;
        pomoState.startTime = Date.now();
        pomoState.lastElapsedSeconds = 0;

        document.getElementById("pomoIdleControls").style.display = "none";
        document.getElementById("pomoRunControls").style.display = "flex";
        
        updateSettingsBtnState();
        updateTabState(); 

        updatePomoStatusText();
        clearInterval(timerId);
        timerId = setInterval(tickPomodoro, 100);

        const tagName = getTag(currentTagId) ? getTag(currentTagId).name : "作業";
        await showSWNotification('?? 作業中: #' + tagName, 'ポモドーロタイマーが稼働しています。', 'timer-persistent');
    }

    function tickPomodoro() {
        if (isAbandonmentPromptOpen) return; 

        const elapsed = Math.floor((Date.now() - pomoState.startTime) / 1000);
        let remaining = pomoState.duration - elapsed;

        if (!pomoState.isBreak) {
            const diff = elapsed - pomoState.lastElapsedSeconds;
            if (diff > 0) {
                logWorkSeconds(diff);
                pomoState.lastElapsedSeconds = elapsed;
            }
        }

        if (remaining <= 0) {
            clearInterval(timerId);
            transitionToNextPomoSection();
            return;
        }

        const m = Math.floor(remaining / 60).toString().padStart(2, "0");
        const s = (remaining % 60).toString().padStart(2, "0");
        document.getElementById("pomo-time-text").textContent = `${m}:${s}`;
        updatePomoStatusText();
        updatePomoGauge((elapsed / pomoState.duration) * 100);
    }

    function updatePomoStatusText() {
        const status = pomoState.isBreak ? "休憩中" : "作業中";
        document.getElementById("pomo-status-text").textContent = `${status} ー ループ ${pomoState.currentLoop}/${pomoSettings.loops}`;
    }

    function skipPomodoroSection() {
        if (!timerId) return;
        clearInterval(timerId);
        transitionToNextPomoSection();
    }

    async function transitionToNextPomoSection() {
        pomoState.lastElapsedSeconds = 0;
        if (!pomoState.isBreak) {
            pomoState.isBreak = true;
            pomoState.duration = pomoSettings.breakMin * 60;
            pomoState.startTime = Date.now();
            showToast("作業完了！休憩に入ります。");
            timerId = setInterval(tickPomodoro, 100);
            
            await showSWNotification("? 休憩時間です", "作業お疲れ様でした。リフレッシュしましょう！", 'timer-alert');
            await showSWNotification('? 休憩中', 'ポモドーロタイマーが稼働しています。', 'timer-persistent');
        } else {
            if (pomoState.currentLoop < pomoSettings.loops) {
                pomoState.currentLoop++;
                pomoState.isBreak = false;
                pomoState.duration = pomoSettings.workMin * 60;
                pomoState.startTime = Date.now();
                showToast(`休憩終了！ループ ${pomoState.currentLoop} を開始します。`);
                timerId = setInterval(tickPomodoro, 100);

                await showSWNotification("?? 作業時間です", "集中して作業に取り組みましょう！", 'timer-alert');
                const tagName = getTag(currentTagId) ? getTag(currentTagId).name : "作業";
                await showSWNotification(`?? 作業中: #${tagName}`, 'ポモドーロタイマーが稼働しています。', 'timer-persistent');
            } else {
                showToast("?? お疲れ様でした！ポモドーロ完了です。");
                stopPomodoro();
                await showSWNotification("?? ポモドーロ完了！", "すべてのセッションが終了しました。お疲れ様でした！", 'timer-alert');
                return;
            }
        }
        updatePomoStatusText();
        updatePomoGauge(0);
    }

    function updatePomoGauge(percent) {
        if (percent > 100) percent = 100;
        const activeColor = getComputedStyle(timerRing).getPropertyValue("--active-color").trim() || "#74b9ff";
        timerRing.style.background = `conic-gradient(${activeColor} ${percent}%, var(--color-surface-2) ${percent}%)`;
    }

    function stopPomodoro() {
        clearInterval(timerId);
        timerId = null;
        pomoState.running = false;
        updatePomoGauge(0);
        updateIdlePomoDisplay();
        document.getElementById("pomoRunControls").style.display = "none";
        document.getElementById("pomoIdleControls").style.display = "flex";
        
        updateSettingsBtnState();
        updateTabState(); 
        
        clearSWNotification('timer-persistent');
    }

    /* ============================================================
        9. ストップウォッチ
    ============================================================ */
    function updateSwRingStyle() {
        const activeColor = getComputedStyle(timerRing).getPropertyValue("--active-color").trim() || "#74b9ff";
        timerRing.style.background = swState.isRunning
            ? `conic-gradient(${activeColor} 100%, ${activeColor} 0%)`
            : `conic-gradient(var(--color-surface-2) 0%, var(--color-surface-2) 0%)`;
    }

    async function toggleStopwatch() {
        const btn = document.getElementById("swPlayBtn");
        if (!swState.isRunning) {
            swState.isRunning = true;
            swState.startTime = Date.now() - swState.elapsedTime;
            swState.lastElapsedSeconds = Math.floor(swState.elapsedTime / 1000);
            clearInterval(timerId);
            timerId = setInterval(tickStopwatch, 50);
            setIconState(btn, true);
            document.getElementById("sw-status-text").textContent = "計測中...";

            const tagName = getTag(currentTagId) ? getTag(currentTagId).name : "作業";
            await showSWNotification(`?? 計測中: #${tagName}`, '現在ストップウォッチが稼働しています（タップで開く）', 'timer-persistent');
        } else {
            swState.isRunning = false;
            clearInterval(timerId);
            setIconState(btn, false);
            document.getElementById("sw-status-text").textContent = "一時停止中";
            
            clearSWNotification('timer-persistent');
        }
        
        updateSwRingStyle();
        updateTabState(); 
    }

    function tickStopwatch() {
        if (isAbandonmentPromptOpen) return; 

        swState.elapsedTime = Date.now() - swState.startTime;
        const elapsed = Math.floor(swState.elapsedTime / 1000);
        const diff = elapsed - swState.lastElapsedSeconds;
        
        if (diff > 0) {
            logWorkSeconds(diff);
            swState.lastElapsedSeconds = elapsed;
        }

        const totalMinutes = Math.floor(elapsed / 60);
        if (totalMinutes > 0 && totalMinutes % 30 === 0 && swState.lastReminderMinutes !== totalMinutes) {
            swState.lastReminderMinutes = totalMinutes;
            showSWNotification('? 計測リマインド', `ストップウォッチ開始から ${totalMinutes} 分経過しました。継続中ですか？`, 'timer-reminder');
        }

        const totalMs = swState.elapsedTime;
        const hrs = Math.floor(totalMs / 3600000).toString().padStart(2, "0");
        const mins = Math.floor((totalMs % 3600000) / 60000).toString().padStart(2, "0");
        const secs = Math.floor((totalMs % 60000) / 1000).toString().padStart(2, "0");
        document.getElementById("sw-time-text").textContent = `${hrs}:${mins}:${secs}`;
    }

    function resetStopwatch() {
        if (currentMode !== "stopwatch") return;
        clearInterval(timerId);
        swState.isRunning = false;
        swState.elapsedTime = 0;
        swState.lastElapsedSeconds = 0;
        swState.lastReminderMinutes = 0;
        
        document.getElementById("sw-time-text").textContent = "00:00:00";
        document.getElementById("sw-status-text").textContent = "タップして計測開始";
        setIconState(document.getElementById("swPlayBtn"), false);
        
        updateSwRingStyle();
        updateTabState(); 
        
        clearSWNotification('timer-persistent');
    }

    /* ============================================================
        10. 汎用確認モーダル
    ============================================================ */
    function openConfirmModal(title, message, confirmText, isDanger, onConfirm) {
        document.getElementById("confirm-title").textContent = title;
        document.getElementById("confirm-body").textContent = message;
        
        const btn = document.getElementById("confirmActionBtn");
        btn.textContent = confirmText;
        btn.className = `modal-btn confirm ${isDanger ? 'danger' : ''}`;
        
        const handler = () => { 
            onConfirm(); 
            closeAllOverlays(); 
        };
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener("click", handler);

        openModal("confirmModal");
    }

    /* ============================================================
        11. カレンダー
    ============================================================ */
    function renderCalendar(year, month) {
        document.getElementById("calendar-month-year").textContent = `${year}年 ${month + 1}月`;
        const grid = document.getElementById("calendarDaysGrid");
        grid.innerHTML = "";

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const daysInMonth = lastDay.getDate();
        const startDayIndex = firstDay.getDay();

        const tagDict = {};
        appTags.forEach(t => tagDict[t.id] = t);

        for (let i = 0; i < startDayIndex; i++) {
            const cell = document.createElement("div");
            cell.className = "calendar-cell inactive";
            grid.appendChild(cell);
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const cell = document.createElement("div");
            cell.className = "calendar-cell";
            cell.textContent = day;

            const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const logData = workLog[dateKey];

            if (logData && logData.total > 0) {
                cell.classList.add("has-log");
                let dominantTagId = null, maxTime = 0;
                for (const tId in logData.tags) {
                    if (logData.tags[tId] > maxTime) { maxTime = logData.tags[tId]; dominantTagId = tId; }
                }
                if (dominantTagId && tagDict[dominantTagId]) {
                    cell.style.setProperty("--dominant-color", tagDict[dominantTagId].color);
                }
            }
            if (dateKey === selectedCalDateString) cell.classList.add("selected");
            cell.addEventListener("click", () => selectCalendarDate(dateKey));
            grid.appendChild(cell);
        }
    }

    function changeMonth(dir) {
        currentCalMonth += dir;
        if (currentCalMonth < 0) { currentCalMonth = 11; currentCalYear -= 1; }
        else if (currentCalMonth > 11) { currentCalMonth = 0; currentCalYear += 1; }
        renderCalendar(currentCalYear, currentCalMonth);
        if (document.getElementById("chart-view-container").style.display !== "none") {
            renderChart(currentCalYear, currentCalMonth);
        }
    }

    function selectCalendarDate(dateString) {
        selectedCalDateString = dateString;
        renderCalendar(currentCalYear, currentCalMonth);
        updateSelectedDayDetail(dateString);
    }

    function updateSelectedDayDetail(dateString) {
        const [y, m, d] = dateString.split("-").map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dayName = jpDayOfWeek[dateObj.getDay()];
        document.getElementById("calSelectedDayText").textContent = `${y}年${m}月${d}日(${dayName})`;

        const logData = workLog[dateString];
        document.getElementById("calSelectedTimeText").textContent = formatSecondsToJp(logData ? logData.total : 0);

        const breakdownContainer = document.getElementById("calSelectedTagBreakdown");
        breakdownContainer.innerHTML = "";
        
        if (logData && logData.tags) {
            const tagDict = {};
            appTags.forEach(t => tagDict[t.id] = t);
            for (const tId in logData.tags) {
                const tSec = logData.tags[tId];
                if (tSec > 0 && tagDict[tId]) {
                    const mins = Math.round(tSec / 60);
                    if (mins >= 0) {
                        const badge = document.createElement("div");
                        badge.className = "tag-badge";
                        badge.style.backgroundColor = `${tagDict[tId].color}26`;
                        badge.style.color = tagDict[tId].color;
                        badge.innerHTML = `<span class="tag-badge-dot" style="background-color:${tagDict[tId].color};"></span>${escapeHtml(tagDict[tId].name)} ${mins}分`;
                        
                        badge.addEventListener("click", () => {
                            openEditLogModal(dateString, tId, mins);
                        });

                        breakdownContainer.appendChild(badge);
                    }
                }
            }
        }
    }

    /* ============================================================
        12. グラフ (Chart.js)
    ============================================================ */
    function switchCalView(viewName) {
        document.getElementById("toggle-cal").classList.toggle("active", viewName === "calendar");
        document.getElementById("toggle-chart").classList.toggle("active", viewName === "chart");
        document.getElementById("cal-view-container").style.display = viewName === "calendar" ? "block" : "none";
        document.getElementById("chart-view-container").style.display = viewName === "chart" ? "block" : "none";
        if (viewName === "chart") renderChart(currentCalYear, currentCalMonth);
    }

    function renderChart(year, month) {
        const ctx = document.getElementById("workChart").getContext("2d");
        const lastDay = new Date(year, month + 1, 0).getDate();
        const labels = [];
        for (let i = 1; i <= lastDay; i++) labels.push(i + "日");

        const datasets = appTags.map(t => ({
            label: t.name, data: new Array(lastDay).fill(0),
            backgroundColor: t.color, borderRadius: 4, tagId: t.id
        }));

        for (let day = 1; day <= lastDay; day++) {
            const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const logData = workLog[dateKey];
            if (logData && logData.tags) {
                for (const tId in logData.tags) {
                    const dsIndex = datasets.findIndex(d => d.tagId === tId);
                    if (dsIndex !== -1) datasets[dsIndex].data[day - 1] = parseFloat((logData.tags[tId] / 60).toFixed(1));
                }
            }
        }

        const activeDatasets = datasets.filter(ds => ds.data.some(v => v > 0));
        if (chartInstance) chartInstance.destroy();

        chartInstance = new Chart(ctx, {
            type: "bar",
            data: { labels, datasets: activeDatasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: "bottom", labels: { color: "#8b93a8", usePointStyle: true, boxWidth: 6, font: { family: "'M PLUS Rounded 1c'" } } },
                    tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y} 分` } }
                },
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { color: "#8b93a8", maxTicksLimit: 8 } },
                    y: { stacked: true, grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: "#8b93a8" }, title: { display: true, text: "作業時間(分)", color: "#8b93a8", font: { size: 10 } } }
                },
                animation: { duration: 400 }
            }
        });
    }

    /* ============================================================
        13. イベント配線
    ============================================================ */
    function wireEvents() {
        document.getElementById("tab-pomo").addEventListener("click", () => switchMode("pomodoro"));
        document.getElementById("tab-sw").addEventListener("click", () => switchMode("stopwatch"));

        document.getElementById("tagChipBtn").addEventListener("click", openTagModal);
        document.getElementById("closeTagModalBtn").addEventListener("click", closeAllOverlays);
        document.getElementById("createTagBtn").addEventListener("click", createNewTag);

        document.getElementById("pomoStartBtn").addEventListener("click", startPomodoro);
        document.getElementById("pomoStopBtn").addEventListener("click", stopPomodoro);
        document.getElementById("pomoSkipBtn").addEventListener("click", skipPomodoroSection);

        document.getElementById("swPlayBtn").addEventListener("click", toggleStopwatch);
        document.getElementById("swResetBtn").addEventListener("click", resetStopwatch);

        document.getElementById("openSettingsBtn").addEventListener("click", () => {
            if (currentMode !== "pomodoro") return;
            loadPomoSettingsIntoInputs();
            openDrawer("settingsDrawer");
        });

        document.querySelectorAll("[data-step-target]").forEach(btn => {
            btn.addEventListener("click", () => {
                const target = btn.getAttribute("data-step-target");
                const delta = parseInt(btn.getAttribute("data-step-delta"), 10);
                const ranges = { "set-loops": [1, 99], "set-work": [1, 180], "set-break": [1, 60] };
                const [min, max] = ranges[target] || [1, 999];
                adjustStepper(target, delta, min, max);
            });
        });

        document.getElementById("openStatsBtn").addEventListener("click", () => {
            openDrawer("statsDrawer");
            renderCalendar(currentCalYear, currentCalMonth);
            updateSelectedDayDetail(selectedCalDateString);
        });
        document.getElementById("toggle-cal").addEventListener("click", () => switchCalView("calendar"));
        document.getElementById("toggle-chart").addEventListener("click", () => switchCalView("chart"));
        document.getElementById("prevMonthBtn").addEventListener("click", () => changeMonth(-1));
        document.getElementById("nextMonthBtn").addEventListener("click", () => changeMonth(1));
    }

    /* ============================================================
        14. 初期化
    ============================================================ */
    function init() {
        wireEvents();
        fn_updateActiveTagDisplay();
        updateIdlePomoDisplay();
        updateSettingsBtnState();
        updateTabState(); 
        renderCalendar(currentCalYear, currentCalMonth);
        updateSelectedDayDetail(selectedCalDateString);
        refreshIcons();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();