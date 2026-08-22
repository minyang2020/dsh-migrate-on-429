/**
 * dsh-migrate-on-429 — 客户端
 *
 * 对话框底部指示器 + 开关 + 「迁移」按钮：
 *   - 徽标显示「当前活跃会话」的连续失败计数（429×N），橙色=有失败；
 *     迁移中显示 ⏳，已迁移显示红色 ⇄；
 *   - 开关切 quickOn；「迁移」按钮手动立即迁移当前活跃会话。
 * 设置页 tab：主开关 / 快捷开关 / LLM 精炼 / 迁移阈值 / 统计窗口 /
 * 立即迁移按钮。所有保存都有回显，控件随轮询同步到真实状态。
 *
 * 纯 DOM API（不依赖 React），通过 HTTP 轮询与宿主端通信。
 */

window.__ModuleLoader__.load({
  id: "dsh-migrate-on-429",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var state = {
      enabled: true,
      quickOn: true,
      buttonHidden: false,
      migrateThreshold: 3,
      windowMs: 180000,
      llmSummary: true,
      activeSessionId: null,
      bySession: {},
      maxFailures: 0,
      lastMigration: null,
    };
    var barEl = null;
    var badgeEl = null;
    var statusEl = null;
    var migrateBtnEl = null;
    var switchTrackEl = null;
    var knobEl = null;
    var switchTextEl = null;
    var pollTimer = null;
    var settingsObserver = null;
    var reattachTimer = null;
    var flashTimer = null;
    var settingsSwitches = {};   // key -> track element（设置页控件同步用）
    var thInput = null;
    var winInput = null;
    var dotEl = null;
    var saveMsgEl = null;
    var migrateMsgEl = null;
    var MIN_THRESHOLD = 2;
    var MAX_THRESHOLD = 50;
    var MIN_WINDOW = 30000;
    var MAX_WINDOW = 3600000;

    function el(tag, style, children) {
      var e = document.createElement(tag);
      if (style) Object.assign(e.style, style);
      if (children) {
        if (!Array.isArray(children)) children = [children];
        children.forEach(function (c) {
          if (c == null) return;
          if (typeof c === "string") e.appendChild(document.createTextNode(c));
          else e.appendChild(c);
        });
      }
      return e;
    }

    // ── 计数模型：只看「当前活跃会话」的 turn 级连续失败 ──────
    function activeInfo() {
      var s = state.bySession ? state.bySession[state.activeSessionId] : null;
      if (!s) return { streak: state.maxFailures || 0, migrated: false, migrating: false, migratedTo: null };
      return { streak: s.turnStreak || 0, migrated: s.migrated, migrating: s.migrating, migratedTo: s.migratedTo || null };
    }
    function lastMigrationRecent() {
      return state.lastMigration && (Date.now() - state.lastMigration.at < 60000);
    }

    function flashBadge(color, text, title) {
      if (!badgeEl) return;
      badgeEl.style.background = color;
      badgeEl.textContent = text;
      if (title) badgeEl.title = title;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(updateBadge, 5000);
    }
    function flashStatus(text, color) {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.style.color = color || "#4CAF50";
      statusEl.style.opacity = "1";
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () { statusEl.style.opacity = "0"; }, 4000);
    }

    function updateBadge() {
      if (!badgeEl) return;
      var info = activeInfo();
      var on = state.quickOn && state.enabled;
      if (lastMigrationRecent()) {
        flashBadge("#FF5722", "⇄", "刚刚完成迁移：任务已交接（非并行）");
        return;
      }
      if (info.migrating) {
        badgeEl.style.background = "#FF9800";
        badgeEl.textContent = "⏳";
        badgeEl.title = "正在迁移当前会话…";
        return;
      }
      if (info.migrated) {
        badgeEl.style.background = "#FF5722";
        badgeEl.textContent = "⇄";
        badgeEl.title = "当前会话已迁移（→ " + (info.migratedTo || "新会话") + "），不再自动继续";
        return;
      }
      badgeEl.style.background = on ? (info.streak > 0 ? "#FF9800" : "#4CAF50") : "#9E9E9E";
      badgeEl.textContent = info.streak > 0 ? "429×" + info.streak : "429";
      badgeEl.title = "当前会话 429 连续失败 " + info.streak + " / 迁移阈值 " + state.migrateThreshold + "（点开关可关，点「迁移」立即交接）";
    }

    function createBar() {
      if (barEl) return;
      barEl = el("div", {
        display: "flex", alignItems: "center", gap: "6px", padding: "0 8px",
        margin: "0 2px", borderRadius: "6px", background: "transparent", border: "none",
        userSelect: "none", fontFamily: "inherit", cursor: "default",
        transition: "opacity 0.2s ease", flexShrink: "0",
      });

      badgeEl = el("span", {
        fontSize: "11px", fontWeight: "700", color: "#fff", background: "#4CAF50",
        padding: "1px 7px", borderRadius: "999px", lineHeight: "16px", whiteSpace: "nowrap",
      });
      badgeEl.textContent = "429";
      barEl.appendChild(badgeEl);

      statusEl = el("span", {
        fontSize: "11px", fontWeight: "600", whiteSpace: "nowrap", opacity: "0",
        transition: "opacity 0.3s ease", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis",
      });
      barEl.appendChild(statusEl);

      migrateBtnEl = el("button", {
        appearance: "none", border: "1px solid var(--dsw-alias-border-l2, #e0e0e0)",
        borderRadius: "999px", padding: "1px 8px", fontSize: "11px", cursor: "pointer",
        background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-secondary, #555)",
        lineHeight: "16px", flexShrink: "0",
      });
      migrateBtnEl.textContent = "迁移";
      migrateBtnEl.title = "立即总结当前会话并迁移到新会话（先停旧、再建新）";
      migrateBtnEl.addEventListener("click", function (e) { e.stopPropagation(); migrateNow(); });
      barEl.appendChild(migrateBtnEl);

      var switchWrap = el("div", { display: "flex", alignItems: "center", gap: "6px" });
      switchTrackEl = el("div", {
        width: "36px", height: "20px", borderRadius: "10px", background: state.quickOn ? "#4CAF50" : "#9E9E9E",
        position: "relative", flexShrink: "0", cursor: "pointer", transition: "background 0.2s ease",
      });
      knobEl = el("div", {
        position: "absolute", top: "2px", left: state.quickOn ? "18px" : "2px", width: "16px", height: "16px",
        borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.35)", transition: "left 0.2s ease",
      });
      switchTrackEl.appendChild(knobEl);
      switchTextEl = el("span", { fontSize: "12px", fontWeight: "600", color: state.quickOn ? "#4CAF50" : "#9E9E9E", transition: "color 0.2s ease" });
      switchTextEl.textContent = state.quickOn ? "开" : "关";
      switchWrap.appendChild(switchTrackEl);
      switchWrap.appendChild(switchTextEl);
      switchTrackEl.addEventListener("click", function (e) { e.stopPropagation(); toggleQuick(); });
      barEl.appendChild(switchWrap);

      attachBar();
      updateBadge();
    }

    // 定位「模型名字」座位：模型选择器触发按钮（aria-haspopup=menu 且
    // aria-label 含「模型」/「model」），返回其包裹 root 与触发按钮。
    function findModelSeat() {
      var btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (var i = 0; i < btns.length; i++) {
        var al = btns[i].getAttribute("aria-label") || "";
        if (al.indexOf("\u6a21\u578b") >= 0 || al.toLowerCase().indexOf("model") >= 0) {
          var parent = btns[i].parentElement;
          if (parent && parent.className && String(parent.className).indexOf("_7KE1Ra_root") >= 0) return { root: parent, trigger: btns[i] };
          return { root: parent || btns[i], trigger: btns[i] };
        }
      }
      // 回退：CSS hash 类名（当前构建稳定为 _7KE1Ra_root）
      var roots = document.querySelectorAll('[class*="_7KE1Ra_root"]');
      for (var j = 0; j < roots.length; j++) {
        if (roots[j].querySelector('button[aria-haspopup="menu"]')) return { root: roots[j], trigger: roots[j].querySelector("button") };
      }
      return null;
    }

    function findComposerTextarea() {
      var tas = document.querySelectorAll("textarea");
      var best = null, bestArea = -1;
      for (var i = 0; i < tas.length; i++) {
        var rect = tas[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var area = rect.width * rect.height;
          if (area > bestArea) { bestArea = area; best = tas[i]; }
        }
      }
      return best;
    }

    function findComposerCard() {
      var ta = findComposerTextarea();
      if (!ta) return null;
      var n = ta;
      for (var d = 0; d < 6 && n; d++) {
        var cls = (n.className || "").toString();
        if (/card|composer|editor/i.test(cls)) return n;
        n = n.parentElement;
      }
      return ta.parentElement;
    }

    // 控件优先放在「模型名字」边上（与模型选择器同一行、其左侧），
    // 避免挡住输入框；仅当找不到模型座位时才退回输入区卡片末尾。
    function attachBar() {
      // 首选：模型名字边上（模型选择器左侧同一行）
      var seat = findModelSeat();
      if (seat && seat.root && seat.root.parentElement) {
        var parent = seat.root.parentElement;
        if (barEl.parentElement !== parent || barEl.nextSibling !== seat.root) {
          if (barEl.parentElement) barEl.remove();
          parent.insertBefore(barEl, seat.root);
        }
        return true;
      }
      // 回退1：任意含「模型」的按钮所在工具栏
      var allBtns = document.querySelectorAll("button");
      var modelBtn = null;
      for (var i = 0; i < allBtns.length; i++) {
        if (allBtns[i].closest(".VOzbGW_panel")) continue;
        var al = (allBtns[i].getAttribute("aria-label") || "") + allBtns[i].textContent;
        if (al.indexOf("\u6a21\u578b") >= 0 || al.toLowerCase().indexOf("model") >= 0) { modelBtn = allBtns[i]; break; }
      }
      if (modelBtn) {
        var wrapper = modelBtn.parentElement;
        if (wrapper) wrapper = wrapper.parentElement;
        var toolbar = wrapper ? wrapper.parentElement : null;
        if (toolbar && wrapper) {
          if (barEl.parentElement === toolbar) return true;
          if (barEl.parentElement) barEl.remove();
          toolbar.insertBefore(barEl, wrapper);
          return true;
        }
      }
      // 回退2：输入区 composer 卡片（不插到输入框正下方，而是放在卡片最末，
      // 即工具栏/发送行之后，尽量不压住 textarea）
      var card = findComposerCard();
      if (card) {
        if (barEl.parentElement === card) return true;
        if (barEl.parentElement) barEl.remove();
        card.appendChild(barEl);
        return true;
      }
      return false;
    }

    function updateBarUI() {
      if (!barEl) return;
      var visible = state.enabled === true && state.buttonHidden !== true;
      barEl.style.display = visible ? "flex" : "none";
      if (!visible) return;
      if (knobEl) knobEl.style.left = state.quickOn ? "18px" : "2px";
      if (switchTrackEl) switchTrackEl.style.background = state.quickOn ? "#4CAF50" : "#9E9E9E";
      if (switchTextEl) {
        switchTextEl.textContent = state.quickOn ? "开" : "关";
        switchTextEl.style.color = state.quickOn ? "#4CAF50" : "#9E9E9E";
      }
      updateBadge();
    }

    function toggleQuick() {
      fetch("/api/migrate-on-429/toggle-quick", { method: "POST" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && typeof data.quickOn === "boolean") { state.quickOn = data.quickOn; updateBarUI(); flashStatus(state.quickOn ? "自动迁移已开" : "自动迁移已关"); }
        })
        .catch(function () { flashStatus("网络错误", "#f44336"); });
    }

    // ── 手动立即迁移 ──────────────────────────────────────────
    function migrateNow() {
      flashStatus("正在迁移…", "#FF9800");
      fetch("/api/migrate-on-429/migrate-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) {
            flashStatus("✓ 已触发迁移，正在交接新会话", "#4CAF50");
            flashBadge("#FF9800", "⏳", "正在迁移当前会话…");
            setTimeout(pollStatus, 1200);
          } else {
            flashStatus("✗ " + ((d && d.error) || "迁移失败"), "#f44336");
            flashBadge("#9E9E9E", "!", "迁移未执行：" + ((d && d.error) || "未知"));
          }
        })
        .catch(function () { flashStatus("✗ 网络错误", "#f44336"); });
    }

    function pollStatus() {
      fetch("/api/migrate-on-429/state")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || typeof data !== "object") return;
          state.enabled = data.enabled;
          state.quickOn = data.quickOn;
          state.buttonHidden = data.buttonHidden;
          state.migrateThreshold = data.migrateThreshold;
          state.windowMs = data.windowMs;
          state.llmSummary = data.llmSummary;
          state.activeSessionId = data.activeSessionId;
          state.bySession = data.bySession || {};
          state.maxFailures = data.maxFailures || 0;
          if (data.lastMigration && (!state.lastMigration || data.lastMigration.at !== state.lastMigration.at)) {
            state.lastMigration = data.lastMigration;
          }
          updateBarUI();
          syncSettingsControls();
          if (state.enabled && barEl && barEl.parentElement === null) attachBar();
        })
        .catch(function () {});
    }

    // ── 设置页 ──────────────────────────────────────────────────
    function setupSettingsTab() {
      var tabInjected = false;

      function tryInjectTab() {
        var panel = document.querySelector(".VOzbGW_panel");
        if (!panel) return;
        var navList = panel.querySelector(".VOzbGW_navList");
        var content = panel.querySelector(".VOzbGW_content");
        if (!navList || !content) return;
        if (tabInjected && navList.querySelector("[data-m429-tab]")) return;
        tabInjected = true;

        var navCell = document.createElement("div");
        navCell.className = "VOzbGW_navCell";
        navCell.setAttribute("data-m429-tab", "1");
        var icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("width", "16");
        icon.setAttribute("height", "16");
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.setAttribute("class", "VOzbGW_navIcon");
        var t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", "2.5");
        t.setAttribute("y", "12");
        t.setAttribute("font-size", "8");
        t.setAttribute("font-weight", "bold");
        t.setAttribute("fill", "currentColor");
        t.textContent = "⇄";
        icon.appendChild(t);
        navCell.appendChild(icon);
        var label = document.createElement("span");
        label.className = "VOzbGW_navLabel";
        label.textContent = "429 自动迁移";
        navCell.appendChild(label);

        var card = createSettingsCard();
        card.id = "m429-settings-card";
        card.style.display = "none";

        var header = content.querySelector(".VOzbGW_header");
        content.insertBefore(card, header ? header.nextSibling : null);

        navList.addEventListener("click", function (e) {
          var target = e.target.closest(".VOzbGW_navCell");
          if (!target) return;
          var allCells = navList.querySelectorAll(".VOzbGW_navCell");
          for (var i = 0; i < allCells.length; i++) allCells[i].classList.remove("VOzbGW_active");
          target.classList.add("VOzbGW_active");
          var isOurTab = target.getAttribute("data-m429-tab") === "1";
          var options = content.querySelector(".VOzbGW_options");
          if (isOurTab) {
            if (options) options.style.display = "none";
            card.style.display = "block";
            syncSettingsControls();
          } else {
            card.style.display = "none";
            if (options) options.style.display = "";
          }
        }, true);

        navList.appendChild(navCell);
        tabInjected = true;
      }

      settingsObserver = new MutationObserver(function () {
        tryInjectTab();
        if (state.enabled && barEl && !document.body.contains(barEl)) attachBar();
        else if (state.enabled && barEl && barEl.parentElement) {
          if (reattachTimer) clearTimeout(reattachTimer);
          reattachTimer = setTimeout(function () { attachBar(); }, 300);
        }
      });
      settingsObserver.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("hashchange", function () { setTimeout(tryInjectTab, 300); });
      setTimeout(tryInjectTab, 1000);
    }

    function createSettingsCard() {
      var card = el("div", {
        border: "1px solid var(--dsw-alias-border-l2, #e0e0e0)",
        background: "var(--dsw-alias-bg-layer-3, #fff)",
        borderRadius: "12px", padding: "16px", margin: "12px 0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      });

      var header = el("div", { display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" });
      dotEl = el("div", {
        width: "10px", height: "10px", borderRadius: "50%",
        background: state.enabled ? "#4CAF50" : "#9E9E9E", flexShrink: "0",
      });
      var title = el("span", { fontSize: "15px", fontWeight: "600", color: "var(--dsw-alias-label-primary, #1a1a1a)" });
      title.textContent = "429 自动迁移";
      header.appendChild(dotEl);
      header.appendChild(title);
      card.appendChild(header);

      var desc = el("p", {
        fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #757575)",
        margin: "0 0 12px", lineHeight: "1.5",
      });
      desc.textContent = "当会话频繁触发 429 TPM 限流（通常因上下文过长）时：先自动 continue 重试，连续失败达到阈值后总结当前会话并迁移到新会话继续任务——先取消旧会话再启动新会话，保证交接而非并行。";
      card.appendChild(desc);

      card.appendChild(makeToggleRow("启用插件", "停用后整体失效，对话框底部不显示开关", "enabled", function (on) {
        fetch("/api/migrate-on-429/toggle", { method: "POST" }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && typeof d.enabled === "boolean") {
            state.enabled = d.enabled;
            if (dotEl) dotEl.style.background = state.enabled ? "#4CAF50" : "#9E9E9E";
            updateBarUI();
            flashStatus(state.enabled ? "插件已启用" : "插件已停用");
          }
        }).catch(function () { flashStatus("✗ 网络错误", "#f44336"); });
      }));

      card.appendChild(makeToggleRow("对话框快捷开关", "与主开关独立，关闭后不触发自动迁移", "quickOn", function (on) {
        fetch("/api/migrate-on-429/toggle-quick", { method: "POST" }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && typeof d.quickOn === "boolean") { state.quickOn = d.quickOn; updateBarUI(); flashStatus(state.quickOn ? "快捷开关已开" : "快捷开关已关"); }
        }).catch(function () { flashStatus("✗ 网络错误", "#f44336"); });
      }));

      card.appendChild(makeToggleRow("LLM 精炼摘要", "迁移前尝试用模型精炼交接总结；失败自动回退结构化提取", "llmSummary", function (on) {
        saveConfig({ llmSummary: on });
      }));

      var thRow = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 12px", padding: "10px 12px", background: "var(--dsw-alias-bg-layer-1, #f7f7f7)", borderRadius: "8px", gap: "12px" });
      var thLabel = el("div", { display: "flex", flexDirection: "column", gap: "2px" });
      var thTitle = el("div", { fontSize: "13px", fontWeight: "500", color: "var(--dsw-alias-label-primary, #1a1a1a)" });
      thTitle.textContent = "迁移阈值（连续失败次数）";
      var thHint = el("div", { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #757575)" });
      thHint.textContent = "达到此数后不再 continue，直接迁移到新会话";
      thLabel.appendChild(thTitle);
      thLabel.appendChild(thHint);
      thInput = el("input", {
        type: "number", min: String(MIN_THRESHOLD), max: String(MAX_THRESHOLD), step: "1",
        value: String(state.migrateThreshold), width: "72px", padding: "5px 8px", fontSize: "13px",
        border: "1px solid var(--dsw-alias-border-l2, #ccc)", borderRadius: "6px",
        background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-primary, #1a1a1a)", textAlign: "center",
      });
      thRow.appendChild(thLabel);
      thRow.appendChild(thInput);
      card.appendChild(thRow);

      var winRow = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 12px", padding: "10px 12px", background: "var(--dsw-alias-bg-layer-1, #f7f7f7)", borderRadius: "8px", gap: "12px" });
      var winLabel = el("div", { display: "flex", flexDirection: "column", gap: "2px" });
      var winTitle = el("div", { fontSize: "13px", fontWeight: "500", color: "var(--dsw-alias-label-primary, #1a1a1a)" });
      winTitle.textContent = "请求级 429 统计窗口（秒）";
      var winHint = el("div", { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #757575)" });
      winHint.textContent = "窗口内请求级 429 达到阈值也会触发迁移";
      winLabel.appendChild(winTitle);
      winLabel.appendChild(winHint);
      winInput = el("input", {
        type: "number", min: String(Math.round(MIN_WINDOW / 1000)), max: String(Math.round(MAX_WINDOW / 1000)), step: "30",
        value: String(Math.round(state.windowMs / 1000)), width: "72px", padding: "5px 8px", fontSize: "13px",
        border: "1px solid var(--dsw-alias-border-l2, #ccc)", borderRadius: "6px",
        background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-primary, #1a1a1a)", textAlign: "center",
      });
      winRow.appendChild(winLabel);
      winRow.appendChild(winInput);
      card.appendChild(winRow);

      var saveBtn = el("button", {
        appearance: "none", border: "1px solid var(--dsw-alias-border-l2, #e0e0e0)", borderRadius: "6px",
        padding: "6px 14px", fontSize: "12px", cursor: "pointer",
        background: "var(--dsw-alias-bg-layer-3, #fff)", color: "var(--dsw-alias-label-secondary, #555)",
      });
      saveBtn.textContent = "保存阈值设置";
      saveMsgEl = el("div", { fontSize: "11px", minHeight: "16px", marginTop: "4px", color: "var(--dsw-alias-label-tertiary, #757575)", transition: "opacity 0.3s ease" });
      saveBtn.addEventListener("click", function () {
        var th = parseInt(thInput.value, 10);
        if (!isFinite(th)) th = state.migrateThreshold;
        if (th < MIN_THRESHOLD) th = MIN_THRESHOLD;
        if (th > MAX_THRESHOLD) th = MAX_THRESHOLD;
        var w = parseInt(winInput.value, 10) * 1000;
        if (!isFinite(w)) w = state.windowMs;
        if (w < MIN_WINDOW) w = MIN_WINDOW;
        if (w > MAX_WINDOW) w = MAX_WINDOW;
        thInput.value = String(th);
        winInput.value = String(Math.round(w / 1000));
        saveConfig({ migrateThreshold: th, windowMs: w });
      });
      var saveRow = el("div", { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });
      saveRow.appendChild(saveBtn);
      saveRow.appendChild(saveMsgEl);
      card.appendChild(saveRow);

      // 立即迁移
      var migBtn = el("button", {
        appearance: "none", border: "1px solid #FF5722", borderRadius: "6px",
        padding: "6px 14px", fontSize: "12px", fontWeight: "600", cursor: "pointer",
        background: "#FF5722", color: "#fff",
      });
      migBtn.textContent = "立即迁移当前会话";
      migBtn.title = "手动触发：总结当前会话并迁移到新会话继续（先停旧再建新）";
      migrateMsgEl = el("div", { fontSize: "11px", minHeight: "16px", marginTop: "4px", color: "var(--dsw-alias-label-tertiary, #757575)" });
      migBtn.addEventListener("click", function () {
        migrateMsgEl.textContent = "正在迁移…";
        migrateMsgEl.style.color = "#FF9800";
        fetch("/api/migrate-on-429/migrate-now", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) {
              migrateMsgEl.textContent = "✓ 已触发迁移，正在交接新会话（旧会话已停）";
              migrateMsgEl.style.color = "#4CAF50";
              setTimeout(pollStatus, 1200);
            } else {
              migrateMsgEl.textContent = "✗ " + ((d && d.error) || "迁移失败");
              migrateMsgEl.style.color = "#f44336";
            }
          })
          .catch(function () { migrateMsgEl.textContent = "✗ 网络错误"; migrateMsgEl.style.color = "#f44336"; });
      });
      var migRow = el("div", { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "12px" });
      migRow.appendChild(migBtn);
      migRow.appendChild(migrateMsgEl);
      card.appendChild(migRow);

      return card;
    }

    // ── 保存 + 回显 ─────────────────────────────────────────────
    function saveConfig(patch) {
      fetch("/api/migrate-on-429/set-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) {
          state.migrateThreshold = d.migrateThreshold;
          state.windowMs = d.windowMs;
          state.llmSummary = d.llmSummary;
          if (saveMsgEl) {
            saveMsgEl.textContent = "✓ 已保存：阈值 " + d.migrateThreshold + " · 窗口 " + Math.round(d.windowMs / 1000) + "s · LLM 精炼 " + (d.llmSummary ? "开" : "关");
            saveMsgEl.style.color = "#4CAF50";
            saveMsgEl.style.opacity = "1";
          }
          syncSettingsControls();
          updateBarUI();
        } else {
          if (saveMsgEl) {
            saveMsgEl.textContent = "✗ " + ((d && d.errors && d.errors.join("；")) || "保存失败");
            saveMsgEl.style.color = "#f44336";
            saveMsgEl.style.opacity = "1";
          }
        }
      }).catch(function () {
        if (saveMsgEl) { saveMsgEl.textContent = "✗ 网络错误"; saveMsgEl.style.color = "#f44336"; saveMsgEl.style.opacity = "1"; }
      });
    }

    function makeToggleRow(labelText, hintText, key, onChange) {
      var row = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 12px", padding: "10px 12px", background: "var(--dsw-alias-bg-layer-1, #f7f7f7)", borderRadius: "8px", gap: "12px" });
      var label = el("div", { display: "flex", flexDirection: "column", gap: "2px" });
      var title = el("div", { fontSize: "13px", fontWeight: "500", color: "var(--dsw-alias-label-primary, #1a1a1a)" });
      title.textContent = labelText;
      var hint = el("div", { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #757575)" });
      hint.textContent = hintText;
      label.appendChild(title);
      label.appendChild(hint);
      var sw = makeSwitch(state[key] !== false, function (on) {
        setSwitchOn(sw, on);
        if (onChange) onChange(on);
      });
      settingsSwitches[key] = sw;
      row.appendChild(label);
      row.appendChild(sw);
      return row;
    }

    function makeSwitch(on, onChange) {
      var track = el("div", {
        width: "36px", height: "20px", borderRadius: "10px", background: on ? "#4CAF50" : "#9E9E9E",
        position: "relative", flexShrink: "0", cursor: "pointer", transition: "background 0.2s ease",
      });
      track.setAttribute("data-on", on ? "1" : "0");
      var knob = el("div", {
        position: "absolute", top: "2px", left: on ? "18px" : "2px", width: "16px", height: "16px",
        borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.35)", transition: "left 0.2s ease",
      });
      track.appendChild(knob);
      track.addEventListener("click", function (e) {
        e.stopPropagation();
        var next = track.getAttribute("data-on") !== "1";
        setSwitchOn(track, next);
        if (onChange) onChange(next);
      });
      return track;
    }
    function setSwitchOn(track, on) {
      track.setAttribute("data-on", on ? "1" : "0");
      track.style.background = on ? "#4CAF50" : "#9E9E9E";
      var knob = track.firstChild;
      if (knob) knob.style.left = on ? "18px" : "2px";
    }

    // ── 设置页控件同步到真实状态（保存后 / 每次轮询）────────────
    function syncSettingsControls() {
      if (dotEl) dotEl.style.background = state.enabled ? "#4CAF50" : "#9E9E9E";
      Object.keys(settingsSwitches).forEach(function (key) {
        var track = settingsSwitches[key];
        if (!track) return;
        var target = state[key] !== false;
        if (track.getAttribute("data-on") !== (target ? "1" : "0")) setSwitchOn(track, target);
      });
      if (thInput && document.activeElement !== thInput) thInput.value = String(state.migrateThreshold);
      if (winInput && document.activeElement !== winInput) winInput.value = String(Math.round(state.windowMs / 1000));
      updateBarUI();
    }

    function init() {
      createBar();
      pollStatus();
      pollTimer = setInterval(pollStatus, 2000);
      setupSettingsTab();
    }

    var inject = [];
    function apply(ctx) {
      var start = function () {
        init();
        if (ctx && typeof ctx.effect === "function") {
          ctx.effect(function () {
            return function () {
              if (pollTimer) clearInterval(pollTimer);
              if (settingsObserver) settingsObserver.disconnect();
              if (barEl) barEl.remove();
            };
          });
        }
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
