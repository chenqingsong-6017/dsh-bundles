/**
 * Client half of dsh-archived-purge.
 *
 * A Settings page that lists every archived Session grouped by workspace,
 * supports select-all / per-group / per-row selection, and permanently deletes
 * the selection. Above the list the automatic sweep is visible: its beat, its
 * last run, the quarantine contents and a one-click restore.
 *
 * Structure note: the client bundle graph is flat — a plugin client is one
 * module and may only require the frozen platform table — so this file cannot
 * be split across files. It is instead composed of small hooks and components:
 * state lives in hooks, markup lives in components, and the page is assembled
 * at the bottom from those pieces.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archived-purge',
  factory(require) {
    const React = require('react'); const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'archived-purge'; const ROUTE = '/plugins/archived-purge'; const MAX_VISIBLE_FILES = 60;
    const HOUR = 60 * 60 * 1000; const DAY = 24 * HOUR;

    const zh = {
      nav: '归档清理', title: '归档会话清理', subtitle: '永久删除已归档会话及其本地资料。删除后无法撤销，也不会影响仍在使用的会话。', statSessions: '归档会话',
      statSize: '占用空间', statActive: '运行中', statSelected: '已选', selectAll: '全选', selected: '已选', total: '共',
      countUnit: '个会话', filesUnit: '个文件', refresh: '刷新', delete: '删除所选', deleting: '正在删除…', confirmTitle: '永久删除会话',
      confirmBody: '将删除 {n} 个会话及其资料，此操作无法撤销：', scopeTitle: '清理范围', scopeSession: '会话日志、投影缓存与归档记录',
      scopeFiles: '该批会话写出的工作区文件', scopeAttachments: '仅被这些会话引用的附件', scopeSchedules: '指向这些会话的定时任务',
      scopeImages: '请求图缩放缓存（可重建）', scopeImagesNote: '{size} · 清空后按需重建', scopeEmpty: '无', showFiles: '查看文件',
      hideFiles: '收起', estimate: '预计释放', scanning: '正在扫描可清理内容…', scanFailed: '无法扫描：{reason}',
      filesNone: '没有可识别的产出文件（只识别 write / edit / present 的路径）', cancel: '取消', confirm: '永久删除', empty: '没有已归档的会话',
      emptyHint: '归档后的会话会出现在这里，可在此统一清理。', size: '占用', lastActivity: '最后活动', missing: '日志缺失', live: '运行中',
      activeTurn: '对话运行中', activeJob: '后台任务运行中', activeSubagent: '子代理运行中', activeSchedule: '定时任务唤醒中',
      activityUnknown: '运行状态未知', scheduleTag: '{n} 个定时任务', ungrouped: '未归组会话', groupSelect: '全选本组',
      groupClear: '取消本组', loadFailed: '读取归档列表失败', deleteFailed: '删除失败', retry: '重试', noticeDeleted: '已删除',
      noticeFreed: '释放', noticeFailed: '删除未完成', noticeFiles: '文件 {n} 个 {size}', noticeAttachments: '附件 {n} 个 {size}',
      noticeSchedules: '定时任务 {n} 个', noticeCache: '图缓存 {size}', pendingFinalizeHint: '另有 {n} 个已删除会话的记账将在下次启动时自动回收',
      deferredSuffix: '（{n} 个的记账待重启后回收）', orphanGc: '清理孤儿附件', orphanGcNone: '没有可清理的孤儿附件',
      orphanGcFound: '发现 {n} 个孤儿附件（{size}），另可清空请求图缓存 {cache}', orphanGcConfirm: '确认清理',
      orphanGcDone: '已清理附件 {n} 个 · 释放 {size}', orphanGcFailed: '清理失败：{message}', leftovers: '扫描历史残留',
      leftoversTitle: '历史残留', leftoversScanning: '正在扫描残留…', leftoversEmpty: '没有发现残留', leftoverFiles: '已删除会话产出的文件',
      leftoverLogs: '残留日志目录', leftoverCaches: '残留投影缓存行', leftoverAccounting: '失效的工作区记账', leftoverArchived: '失效的归档标记',
      leftoverAttachments: '无人引用的附件', leftoverCache: '请求图缓存', leftoverChanged: '（{n} 个已被改动，跳过）',
      leftoverFilesNote: '共 {n} 个，已选 {m} 个', leftoverPurge: '永久删除所选', leftoverDone: '已清理残留：释放 {size}',
      leftoverCount: '{n} 项', irreversible: '此操作不可撤销', deepAttachments: '附件', deepBlocked: '无法扫描：{reason}',
      details: '原因',
    };

    const en = {
      nav: 'Archive Cleanup', title: 'Archived session cleanup',
      subtitle: 'Permanently delete archived sessions and what they produced on disk. This cannot be undone and never touches sessions still in use.',
      statSessions: 'Archived', statSize: 'On disk', statActive: 'Running', statSelected: 'Selected',
      selectAll: 'Select all', selected: 'Selected', total: 'of', countUnit: 'sessions', filesUnit: 'files',
      refresh: 'Refresh', delete: 'Delete selected', deleting: 'Deleting…',
      confirmTitle: 'Permanently delete sessions',
      confirmBody: '{n} sessions and their materials will be deleted. This cannot be undone:', scopeTitle: 'Scope',
      scopeSession: 'Session log, projection cache and archive record',
      scopeFiles: 'Workspace files these sessions wrote',
      scopeAttachments: 'Attachments only these sessions reference',
      scopeSchedules: 'Scheduled tasks aimed at these sessions', scopeImages: 'Request-image cache (regenerable)',
      scopeImagesNote: '{size} · rebuilt on demand', scopeEmpty: 'none', showFiles: 'Show files', hideFiles: 'Hide',
      estimate: 'Frees about', scanning: 'Scanning reclaimable data…', scanFailed: 'Cannot scan: {reason}',
      filesNone: 'No identifiable artifacts (only write / edit / present paths are detected)', cancel: 'Cancel',
      confirm: 'Delete permanently', empty: 'No archived sessions',
      emptyHint: 'Archived sessions appear here and can be cleaned up in one place.', size: 'Size',
      lastActivity: 'Last activity', missing: 'Log missing', live: 'Running', activeTurn: 'Turn running',
      activeJob: 'Job running', activeSubagent: 'Subagent running', activeSchedule: 'Schedule waking',
      activityUnknown: 'Activity unknown', scheduleTag: '{n} scheduled task(s)', ungrouped: 'Ungrouped sessions',
      groupSelect: 'Select group', groupClear: 'Clear group', loadFailed: 'Failed to read archived sessions',
      deleteFailed: 'Deletion failed', retry: 'Retry', noticeDeleted: 'Deleted', noticeFreed: 'Freed',
      noticeFailed: 'Deletion not completed', noticeFiles: '{n} files {size}',
      noticeAttachments: '{n} attachments {size}', noticeSchedules: '{n} scheduled tasks',
      noticeCache: 'image cache {size}',
      pendingFinalizeHint: '{n} deleted Sessions still hold bookkeeping that clears on the next start',
      deferredSuffix: ' ({n} waiting for the next start)', orphanGc: 'Clean orphan attachments',
      orphanGcNone: 'No orphan attachments to clean',
      orphanGcFound: '{n} orphan attachments ({size}); the request-image cache ({cache}) can be cleared too',
      orphanGcConfirm: 'Clean them', orphanGcDone: 'Removed {n} attachments · freed {size}',
      orphanGcFailed: 'Cleanup failed: {message}', leftovers: 'Scan leftovers', leftoversTitle: 'Leftovers',
      leftoversScanning: 'Scanning leftovers…', leftoversEmpty: 'No leftovers found',
      leftoverFiles: 'Files produced by deleted Sessions', leftoverLogs: 'Orphan log directories',
      leftoverCaches: 'Orphan projection-cache rows', leftoverAccounting: 'Dangling workspace slots',
      leftoverArchived: 'Dangling archive markers', leftoverAttachments: 'Unreferenced attachments',
      leftoverCache: 'Request-image cache', leftoverChanged: ' ({n} changed since, skipped)',
      leftoverFilesNote: '{n} found, {m} selected', leftoverPurge: 'Delete selected permanently',
      leftoverDone: 'Leftovers cleared: freed {size}', leftoverCount: '{n} items',
      irreversible: 'This action cannot be undone', deepAttachments: 'Attachments',
      deepBlocked: 'Cannot scan: {reason}', details: 'Reasons',
    };


    // The automatic-sweep strings live here so the vendored dictionaries above
    // stay byte-identical to upstream and can be re-vendored without conflict.
    const AUTO_ZH = {
      autoTitle: '自动清理', autoOn: '开着', autoOff: '已关闭',
      autoSummary: '每 {interval} 小时一轮 · 归档 {grace} 天未动才隔离 · 隔离保留 {retain} 天后清除', autoLast: '上次', autoNext: '下次约',
      autoNever: '还没跑过第一轮', autoHeld: '隔离区 {n} 条 · {size}，最早 {days} 天后永久清除', autoEmpty: '隔离区是空的', autoRestore: '还原',
      autoRecheck: '立即检查', autoCheckRunning: '正在检查…', autoRestored: '已还原 {n} 项', autoRestoreFailed: '还原失败：{message}',
      autoChecked: '本轮会隔离 {n} 条，其余 {skipped} 条暂不动', autoCheckFailed: '检查失败：{message}',
      autoHint: '隔离期内的会话可以还原；到期后才永久删除。',
    };
    const AUTO_EN = {
      autoTitle: 'Automatic cleanup', autoOn: 'on', autoOff: 'off',
      autoSummary: 'every {interval} h · hold after {grace} idle days · keep {retain} days', autoLast: 'last',
      autoNext: 'next', autoNever: 'has not run yet',
      autoHeld: 'quarantine: {n} · {size}, earliest cleared in {days} days', autoEmpty: 'the quarantine is empty',
      autoRestore: 'restore', autoRecheck: 'check now', autoCheckRunning: 'checking…',
      autoRestored: 'restored {n} item(s)', autoRestoreFailed: 'restore failed: {message}',
      autoChecked: 'this round would hold {n}, leaves {skipped} alone', autoCheckFailed: 'check failed: {message}',
      autoHint: 'held Sessions are restorable until the retention window ends.',
    };

    const CSS = `
      .ap-root { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
      .ap-hero { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
        background: linear-gradient(135deg, color-mix(in oklab, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1)), var(--dsw-alias-bg-layer-1) 62%); }
      .ap-title { font-size: 17px; font-weight: 650; letter-spacing: .01em; }
      .ap-sub { font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); max-width: 72ch; }
      .ap-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
      .ap-stat { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px;
        background: color-mix(in oklab, var(--dsw-alias-bg-base) 62%, transparent);
        border: 1px solid var(--dsw-alias-border-l1); }
      .ap-statvalue { font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; }
      .ap-statlabel { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ap-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
        position: sticky; top: 0; z-index: 2; }
      .ap-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
      .ap-check input, .ap-row input[type="checkbox"], .ap-deeprow input[type="checkbox"], .ap-file input[type="checkbox"] {
        width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ap-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .ap-spacer { flex: 1; }
      .ap-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
        transition: background-color .12s ease, border-color .12s ease, opacity .12s ease; }
      .ap-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ap-btn:disabled { opacity: .45; cursor: not-allowed; }
      .ap-btn:focus-visible, .ap-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .ap-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .ap-danger:hover:not(:disabled) { background: color-mix(in oklab, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .ap-primary-danger { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-bg-base); font-weight: 600; }
      .ap-primary-danger:hover:not(:disabled) { filter: brightness(1.06); }
      .ap-link { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-brand-primary);
        font: inherit; font-size: 11.5px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
      .ap-link:hover { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent); }
      .ap-group { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden;
        background: var(--dsw-alias-bg-base); }
      .ap-grouphead { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .ap-grouptitle { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ap-grouppath { font-size: 11px; color: var(--dsw-alias-label-secondary); direction: rtl;
        max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ap-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; cursor: pointer;
        border-top: 1px solid var(--dsw-alias-border-l1); transition: background-color .12s ease; }
      .ap-row:hover { background: var(--dsw-alias-bg-layer-1); }
      .ap-row input[type="checkbox"] { margin-top: 3px; flex: none; }
      .ap-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
      .ap-name { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
      .ap-name.ap-unknown { color: var(--dsw-alias-label-secondary); font-style: italic; }
      .ap-tags { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .ap-tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .ap-tag.ap-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
      .ap-tag.ap-live { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
      .ap-tag.ap-schedule { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .ap-notice { padding: 9px 12px; border-radius: 10px; font-size: 12px; line-height: 1.55;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .ap-notice.ap-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .ap-noticelist { margin: 6px 0 0; padding-left: 18px; max-height: 160px; overflow: auto; }
      .ap-deep { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 10px 12px;
        display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-1); }
      .ap-deeptitle { font-size: 12px; font-weight: 600; }
      .ap-scopehead { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
        color: var(--dsw-alias-label-secondary); }
      .ap-deeprow { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; min-height: 24px; }
      .ap-deeprow .ap-meta { margin-left: auto; }
      .ap-filelist { max-height: 168px; overflow: auto; display: flex; flex-direction: column; gap: 1px;
        padding: 4px 0 4px 22px; }
      .ap-file { display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; min-width: 0;
        padding: 3px 6px; border-radius: 6px; }
      .ap-file:hover { background: var(--dsw-alias-bg-layer-2); }
      .ap-filename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); }
      .ap-total { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
      .ap-total strong { font-size: 15px; font-variant-numeric: tabular-nums; }
      .ap-empty { padding: 44px 12px; text-align: center; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; }
      .ap-empty-title { font-size: 13px; margin-bottom: 4px; font-weight: 600; }
      .ap-empty-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ap-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
        background: color-mix(in oklab, var(--dsw-alias-label-primary) 42%, transparent); padding: 24px; }
      .ap-dialog { width: min(520px, 100%); max-height: calc(100vh - 48px); overflow: auto;
        background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px;
        box-shadow: 0 18px 48px color-mix(in oklab, var(--dsw-alias-label-primary) 28%, transparent); }
      .ap-dialogtitle { font-size: 15px; font-weight: 650; }
      .ap-dialogbody { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .ap-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
      .ap-actions .ap-spacer { min-width: 8px; }
      @media (max-width: 560px) {
        .ap-bar { position: static; }
        .ap-hero { padding: 14px; }
        .ap-grouppath { display: none; }
        .ap-overlay { padding: 12px; align-items: flex-end; }
        .ap-dialog { max-height: calc(100vh - 24px); }
      }
    `;
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes; let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024; unit += 1;
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    function baseName(filePath) {
      const parts = String(filePath ?? '').split(/[\\/]/); return parts[parts.length - 1] || String(filePath ?? '');
    }

    // Activity families reported by the Host's `workspace/session-activity`
    // waterfall; unknown families fall back to their raw name.
    const ACTIVITY_LABELS = {
      turn: 'activeTurn', job: 'activeJob', subagent: 'activeSubagent', schedule: 'activeSchedule',
    };

    function activityLabel(t, kind) {
      const key = ACTIVITY_LABELS[kind]; return key ? t(key) : String(kind ?? '');
    }

    async function request(path, init) {
      const response = await fetch(ROUTE + path, {
        cache: 'no-store', credentials: 'same-origin',
        ...init,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const error = new Error(payload?.message || `HTTP ${response.status}`);
        error.payload = payload; error.status = response.status; throw error;
      }
      return payload;
    }


    function fill(template, values) {
      let out = String(template);
      for (const [key, value] of Object.entries(values)) out = out.replace(`{${key}}`, String(value));
      return out;
    }

    // ---------- presentation ----------

    function Check({ checked, onChange, label, disabled = false }) {
      return h('input', { type: 'checkbox', checked, disabled, onChange, 'aria-label': label });
    }

    function Stat({ value, label }) {
      return h('div', { className: 'ap-stat' },
        h('span', { className: 'ap-statvalue' }, value),
        h('span', { className: 'ap-statlabel' }, label),
      );
    }

    function PanelHeader({ t, data, total, activeCount, selectedCount, selectedBytes }) {
      return h('header', { className: 'ap-hero' },
        h('div', { className: 'ap-title' }, t('title')),
        h('div', { className: 'ap-sub' }, t('subtitle')),
        h('div', { className: 'ap-stats' },
          h(Stat, { value: String(data?.archivedCount ?? total), label: t('statSessions') }),
          h(Stat, { value: formatBytes(data?.totalBytes ?? 0), label: t('statSize') }),
          h(Stat, { value: String(activeCount), label: t('statActive') }),
          h(Stat, { value: `${selectedCount} · ${formatBytes(selectedBytes)}`, label: t('statSelected') }),
        ),
      );
    }

    function Toolbar({ t, masterRef, allSelected, onToggleAll, total, busy, selectedCount, loading,
      onLeftovers, onGc, onRefresh, onDelete, leftoversBusy, gcBusy }) {
      return h('div', { className: 'ap-bar' },
        h('label', { className: 'ap-check' },
          h('input', {
            ref: masterRef, type: 'checkbox', checked: allSelected, onChange: onToggleAll,
            disabled: total === 0 || busy,
            'aria-label': t('selectAll'),
          }),
          t('selectAll'),
        ),
        h('span', { className: 'ap-meta' }, `${t('selected')} ${selectedCount} / ${total}`),
        h('span', { className: 'ap-spacer' }),
        h('button', { type: 'button', className: 'ap-btn', onClick: onLeftovers, disabled: loading || busy || leftoversBusy }, t('leftovers')),
        h('button', { type: 'button', className: 'ap-btn', onClick: onGc, disabled: loading || busy || gcBusy }, t('orphanGc')),
        h('button', { type: 'button', className: 'ap-btn', onClick: onRefresh, disabled: loading || busy }, t('refresh')),
        h('button', { type: 'button', className: 'ap-btn ap-danger', onClick: onDelete, disabled: selectedCount === 0 || busy },
          busy ? t('deleting') : t('delete')),
      );
    }

    function NoticeView({ t, error, notice }) {
      if (error) return h('div', { className: 'ap-notice ap-error' }, `${t('loadFailed')}：${error}`);
      if (!notice) return null;
      return h('div', { className: notice.kind === 'error' ? 'ap-notice ap-error' : 'ap-notice' },
        h('div', null, notice.text),
        Array.isArray(notice.details) && notice.details.length > 0
          ? h('ul', { className: 'ap-noticelist' }, notice.details.map((line, index) => h('li', { key: index }, line)))
          : null,
      );
    }

    function GcPrompt({ t, gc, onConfirm, onCancel }) {
      if (!gc?.pending) return null;
      return h('div', { className: 'ap-notice' },
        h('div', null, fill(t('orphanGcFound'), {
          n: gc.pending.orphanObjects ?? 0, size: formatBytes(gc.pending.orphanBytes ?? 0),
          cache: formatBytes(gc.pending.requestImages?.bytes ?? 0),
        })),
        h('div', { className: 'ap-actions' },
          h('button', { type: 'button', className: 'ap-btn', onClick: onCancel }, t('cancel')),
          h('button', { type: 'button', className: 'ap-btn ap-danger', onClick: onConfirm }, t('orphanGcConfirm')),
        ),
      );
    }

    function AutoCard({ t, auto }) {
      const { status } = auto;
      const summary = status
        ? fill(t('autoSummary'), {
          interval: status.config?.intervalHours, grace: status.config?.graceDays, retain: status.config?.retainDays,
        })
        : '';
      const held = status?.held ?? [];
      const rows = [h('div', { className: 'ap-autohead', key: 'head' },
        h('span', { className: 'ap-autotitle' }, status
          ? `${t('autoTitle')} · ${status.enabled ? t('autoOn') : t('autoOff')}`
          : t('autoTitle')),
        h('span', { className: 'ap-meta' }, summary),
      )];
      if (status) {
        rows.push(h('div', { className: 'ap-meta', key: 'beat' }, status.lastRunAt
          ? `${t('autoLast')} ${new Date(status.lastRunAt).toLocaleString()} · ${t('autoNext')} ${new Date(status.nextRunAt ?? 0).toLocaleString()}`
          : t('autoNever')));
      }
      if (auto.notice) rows.push(h('div', { className: 'ap-meta', key: 'notice' }, auto.notice));
      if (held.length === 0) {
        rows.push(h('div', { className: 'ap-meta', key: 'empty' }, t('autoEmpty')));
      } else {
        rows.push(h('div', { className: 'ap-meta', key: 'held' }, fill(t('autoHeld'), {
          n: held.length, size: formatBytes(held.reduce((sum, entry) => sum + entry.bytes, 0)),
          days: Math.max(0, Math.ceil((held[0].expiresInMs ?? 0) / DAY)),
        })));
        for (const entry of held.slice(0, 6)) {
          rows.push(h('div', { className: 'ap-autoheld', key: entry.entryId },
            h('span', { className: 'ap-autoname', title: entry.entryId }, entry.title || entry.sessionId),
            h('span', { className: 'ap-meta' }, formatBytes(entry.bytes)),
            h('button', {
              type: 'button', className: 'ap-link', disabled: auto.busy === entry.entryId,
              onClick: () => auto.restore(entry.entryId),
            }, t('autoRestore'))));
        }
      }
      rows.push(h('div', { className: 'ap-actions', key: 'actions' },
        h('span', { className: 'ap-meta ap-spacer' }, t('autoHint')),
        h('button', { type: 'button', className: 'ap-btn', disabled: auto.checking, onClick: auto.check },
          auto.checking ? t('autoCheckRunning') : t('autoRecheck')),
      ));
      return h('section', { className: 'ap-auto' }, rows);
    }

    function activityCell(t, item) {
      if (item.active) return h('span', { className: 'ap-tag ap-live' }, activityLabel(t, item.activity?.[0]) || t('live'));
      if (item.activityUnknown) return h('span', { className: 'ap-tag ap-warn' }, t('activityUnknown'));
      return null;
    }

    function ArchiveRow({ t, item, selected, onToggle }) {
      return h('label', { className: 'ap-row' },
        h(Check, { checked: selected, onChange: () => onToggle(item.id), label: item.title || item.id }),
        h('div', { className: 'ap-body' },
          h('div', { className: 'ap-name' + (item.title ? '' : ' ap-unknown') }, item.title || item.id),
          h('div', { className: 'ap-tags' },
            h('span', { className: 'ap-meta' }, `${t('size')} ${formatBytes(item.sizeBytes)}`),
            item.lastActivity
              ? h('span', { className: 'ap-meta' }, `${t('lastActivity')} ${new Date(item.lastActivity).toLocaleString()}`)
              : null,
            item.scheduleCount > 0
              ? h('span', { className: 'ap-tag ap-schedule' }, fill(t('scheduleTag'), { n: item.scheduleCount }))
              : null,
            item.exists ? null : h('span', { className: 'ap-tag ap-warn' }, t('missing')),
            activityCell(t, item),
          ),
        ),
      );
    }

    function ArchiveGroup({ t, group, selected, onToggle, allInGroup, onToggleGroup }) {
      return h('section', { className: 'ap-group' },
        h('div', { className: 'ap-grouphead' },
          h('span', { className: 'ap-grouptitle' }, group.title),
          group.path ? h('span', { className: 'ap-grouppath', title: group.path }, group.path) : null,
          h('span', { className: 'ap-spacer' }),
          h('span', { className: 'ap-meta' }, `${group.items.length} ${t('countUnit')}`),
          h('button', { type: 'button', className: 'ap-link', onClick: () => onToggleGroup(group) },
            allInGroup ? t('groupClear') : t('groupSelect')),
        ),
        group.items.map((item) => h(ArchiveRow, { key: item.id, t, item, selected: selected.has(item.id), onToggle })),
      );
    }

    function ArchiveList({ t, loading, total, groups, selected, onToggle, allInGroup, onToggleGroup }) {
      if (loading) return h('div', { className: 'ap-meta' }, '…');
      if (total === 0) {
        return h('div', { className: 'ap-empty' },
          h('div', { className: 'ap-empty-title' }, t('empty')),
          h('div', { className: 'ap-empty-hint' }, t('emptyHint')),
        );
      }
      return groups.map((group) => h(ArchiveGroup, {
        key: group.key, t, group, selected, onToggle, allInGroup: allInGroup(group), onToggleGroup,
      }));
    }

    function FileRow({ t, file, checked, onChange }) {
      return h('label', { className: 'ap-file' },
        h('input', { type: 'checkbox', checked, onChange }),
        h('span', { className: 'ap-filename', title: file.path }, baseName(file.path)),
        h('span', { className: 'ap-meta' }, formatBytes(file.bytes)),
      );
    }

    function LeftoverRow({ t, name, label, count, bytes, checked, onFlag }) {
      return h('label', { className: 'ap-deeprow' },
        h('input', {
          type: 'checkbox', checked: Boolean(checked), disabled: count === 0,
          onChange: (event) => onFlag(name, event.target.checked),
        }),
        h('span', null, label),
        h('span', { className: 'ap-meta' }, count === 0 ? '—' : `${count}${bytes ? ` · ${formatBytes(bytes)}` : ''}`),
      );
    }

    function LeftoverFiles({ t, plan, sel, changed, onToggleFile }) {
      return [
        h(LeftoverRow, {
          key: 'files', t, name: 'files', label: t('leftoverFiles'), count: plan.files.length,
          bytes: plan.files.filter((file) => !file.changed).reduce((sum, file) => sum + file.bytes, 0),
          checked: sel.files.size > 0, onFlag: () => {},
        }),
        changed > 0 ? h('div', { className: 'ap-meta', key: 'changed' }, fill(t('leftoverChanged'), { n: changed })) : null,
        plan.files.length > 0
          ? h('div', { className: 'ap-filelist', key: 'list' }, plan.files.slice(0, MAX_VISIBLE_FILES).map((file) => h('label', { className: 'ap-file', key: file.path },
            h('input', {
              type: 'checkbox', checked: sel.files.has(file.path), disabled: file.changed,
              onChange: () => onToggleFile(file.path),
            }),
            h('span', { className: 'ap-filename', title: file.path }, file.path),
            h('span', { className: 'ap-meta' }, file.changed ? fill(t('leftoverChanged'), { n: 1 }) : formatBytes(file.bytes)),
          )))
          : null,
      ];
    }

    function LeftoverPanel({ t, plan, sel, changed, free, onToggleFile, onFlag, onCancel, onPurge }) {
      if (!plan || !sel) return null;
      return h('div', { className: 'ap-notice ap-deep' },
        h('div', { className: 'ap-deeptitle' }, t('leftoversTitle')),
        h(LeftoverFiles, { t, plan, sel, changed, onToggleFile }),
        h(LeftoverRow, { t, name: 'logs', label: t('leftoverLogs'), count: plan.logs.length, bytes: plan.logs.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), checked: sel.logs, onFlag }),
        h(LeftoverRow, { t, name: 'caches', label: t('leftoverCaches'), count: plan.caches.length, bytes: plan.caches.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), checked: sel.caches, onFlag }),
        h(LeftoverRow, { t, name: 'accounting', label: t('leftoverAccounting'), count: plan.accounting.length, bytes: 0, checked: sel.accounting, onFlag }),
        h(LeftoverRow, { t, name: 'archived', label: t('leftoverArchived'), count: plan.archived.length, bytes: 0, checked: sel.archived, onFlag }),
        h(LeftoverRow, { t, name: 'attachments', label: t('leftoverAttachments'), count: plan.attachments?.orphanObjects ?? 0, bytes: plan.attachments?.orphanBytes ?? 0, checked: sel.attachments, onFlag }),
        h(LeftoverRow, { t, name: 'requestImages', label: t('leftoverCache'), count: plan.requestImages?.files ?? 0, bytes: plan.requestImages?.bytes ?? 0, checked: sel.requestImages, onFlag }),
        h('div', { className: 'ap-actions' },
          h('span', { className: 'ap-meta ap-spacer' }, `${t('noticeFreed')} ${formatBytes(free)}`),
          h('button', { type: 'button', className: 'ap-btn', onClick: onCancel }, t('cancel')),
          h('button', { type: 'button', className: 'ap-btn ap-primary-danger', onClick: onPurge }, t('leftoverPurge')),
        ),
      );
    }

    function ScopeSessionRow({ t, selectedBytes }) {
      return h('div', { className: 'ap-deeprow' },
        h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }),
        h('span', null, t('scopeSession')),
        h('span', { className: 'ap-meta' }, formatBytes(selectedBytes)),
      );
    }

    function ScopeFilesRow({ t, artifacts, deep, setDeep, keptFiles, keptBytes, showFiles, setShowFiles, excluded, onToggleFile }) {
      return h('div', null,
        h('div', { className: 'ap-deeprow' },
          h('input', {
            type: 'checkbox', checked: deep.files, disabled: artifacts.length === 0,
            onChange: (event) => setDeep((current) => ({ ...current, files: event.target.checked })),
          }),
          h('span', null, t('scopeFiles')),
          h('span', { className: 'ap-meta' }, artifacts.length === 0
            ? t('filesNone')
            : `${keptFiles.length} ${t('filesUnit')} · ${formatBytes(keptBytes)}`),
          artifacts.length > 0
            ? h('button', { type: 'button', className: 'ap-link', onClick: () => setShowFiles((current) => !current) },
              showFiles ? t('hideFiles') : t('showFiles'))
            : null,
        ),
        showFiles && artifacts.length > 0
          ? h('div', { className: 'ap-filelist' }, artifacts.slice(0, MAX_VISIBLE_FILES).map((file) => h(FileRow, {
            key: file.path, t, file, checked: !excluded.has(file.path), onChange: () => onToggleFile(file.path),
          })))
          : null,
      );
    }

    function ScopeAttachmentsRow({ t, scanned, deep, setDeep, orphanCount, orphanBytes }) {
      return h('div', { className: 'ap-deeprow' },
        h('input', {
          type: 'checkbox', checked: deep.attachments, disabled: orphanCount === 0,
          onChange: (event) => setDeep((current) => ({ ...current, attachments: event.target.checked })),
        }),
        h('span', null, t('scopeAttachments')),
        h('span', { className: 'ap-meta' }, scanned.attachments?.blocked
          ? fill(t('deepBlocked'), { reason: scanned.attachments.blocked })
          : orphanCount === 0
            ? t('scopeEmpty')
            : `${orphanCount} · ${formatBytes(orphanBytes)}`),
      );
    }

    function ScopeCacheRow({ t, deep, setDeep, cacheBytes }) {
      return h('div', { className: 'ap-deeprow' },
        h('input', {
          type: 'checkbox', checked: deep.requestImages, disabled: cacheBytes === 0,
          onChange: (event) => setDeep((current) => ({ ...current, requestImages: event.target.checked })),
        }),
        h('span', null, t('scopeImages')),
        h('span', { className: 'ap-meta' }, cacheBytes === 0
          ? t('scopeEmpty')
          : fill(t('scopeImagesNote'), { size: formatBytes(cacheBytes) })),
      );
    }

    function ScopeBlock({ t, scope, selectedBytes }) {
      const { scan, scanned, deep, setDeep, artifacts, keptFiles, keptBytes, orphanCount, orphanBytes,
        scheduleCount, cacheBytes, showFiles, setShowFiles, excluded, onToggleFile } = scope;
      return h('div', { className: 'ap-deep' },
        h('div', { className: 'ap-scopehead' }, t('scopeTitle')),
        h(ScopeSessionRow, { t, selectedBytes }),
        scan?.loading
          ? h('div', { className: 'ap-meta' }, t('scanning'))
          : scan?.error
            ? h('div', { className: 'ap-meta' }, fill(t('scanFailed'), { reason: scan.error }))
            : scanned
              ? [
                h(ScopeFilesRow, { key: 'files', t, artifacts, deep, setDeep, keptFiles, keptBytes, showFiles, setShowFiles, excluded, onToggleFile }),
                h(ScopeAttachmentsRow, { key: 'attachments', t, scanned, deep, setDeep, orphanCount, orphanBytes }),
                scheduleCount > 0
                  ? h('div', { className: 'ap-deeprow', key: 'schedules' },
                    h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }),
                    h('span', null, t('scopeSchedules')),
                    h('span', { className: 'ap-meta' }, String(scheduleCount)))
                  : null,
                h(ScopeCacheRow, { key: 'cache', t, deep, setDeep, cacheBytes }),
              ]
              : null,
      );
    }

    function ConfirmDialog({ t, dialog, scope, selectedBytes }) {
      const { open, close, run, busy, selectedCount } = dialog;
      if (!open) return null;
      return h('div', {
        className: 'ap-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close();
        },
      }, h('div', {
        className: 'ap-dialog', role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ap-confirm-title',
      },
      h('div', { className: 'ap-dialogtitle', id: 'ap-confirm-title' }, t('confirmTitle')),
      h('div', { className: 'ap-dialogbody' }, fill(t('confirmBody'), { n: selectedCount })),
      h(ScopeBlock, { t, scope, selectedBytes }),
      h('div', { className: 'ap-dialogbody ap-total' },
        h('span', null, `${t('estimate')}`),
        h('strong', null, formatBytes(scope.totalFree)),
      ),
      h('div', { className: 'ap-dialogbody' }, t('irreversible')),
      h('div', { className: 'ap-actions' },
        h('button', { type: 'button', className: 'ap-btn', onClick: close }, t('cancel')),
        h('button', {
          type: 'button', className: 'ap-btn ap-primary-danger', onClick: run,
          disabled: scope.scan?.loading === true || busy, autoFocus: true,
        }, t('confirm')),
      ),
      ));
    }

    // ---------- hooks ----------

    function useArchiveData(t) {
      const [loading, setLoading] = useState(true); const [data, setData] = useState(null);
      const [error, setError] = useState(''); const [selected, setSelected] = useState(() => new Set());
      const load = useCallback(async () => {
        setLoading(true); setError('');
        try {
          const next = await request('/state'); setData(next);
          setSelected((current) => {
            const alive = new Set(next.items.map((item) => item.id)); const kept = new Set();
            for (const id of current) if (alive.has(id)) kept.add(id); return kept;
          });
        } catch (cause) {
          setError(cause?.message || t('loadFailed'));
        } finally {
          setLoading(false);
        }
      }, [t]);
      useEffect(() => { load(); }, [load]);
      return { loading, data, error, selected, setSelected, load };
    }

    function useGroups(items, t) {
      return useMemo(() => {
        const map = new Map();
        for (const item of items) {
          const key = item.workspaceId || '__none__';
          const group = map.get(key) ?? {
            key, title: item.workspaceTitle || t('ungrouped'),
            path: item.workspacePath || '', items: [],
          };
          group.items.push(item); map.set(key, group);
        }
        return [...map.values()];
      }, [items, t]);
    }

    function useSelection(items, selected, setSelected, clearNotice) {
      const allSelected = items.length > 0 && selected.size === items.length;
      const toggle = (id) => {
        setSelected((current) => {
          const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
        });
        clearNotice();
      };
      const toggleAll = () => {
        setSelected(() => (allSelected ? new Set() : new Set(items.map((item) => item.id)))); clearNotice();
      };
      const allInGroup = (group) => group.items.every((item) => selected.has(item.id));
      const toggleGroup = (group) => {
        const pick = !allInGroup(group);
        setSelected((current) => {
          const next = new Set(current);
          for (const item of group.items) {
            if (pick) next.add(item.id); else next.delete(item.id);
          }
          return next;
        });
        clearNotice();
      };
      return { allSelected, someSelected: selected.size > 0 && !allSelected, toggle, toggleAll, allInGroup, toggleGroup };
    }

    function useScanFlow({ t, selected, items }) {
      const [confirming, setConfirming] = useState(false); const [scan, setScan] = useState(null);
      const startScan = useCallback(async (ids) => {
        setScan({ loading: true, data: null, error: '' });
        try {
          const next = await request('/scan', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionIds: ids }),
          });
          setScan({ loading: false, data: next, error: '' });
        } catch (cause) {
          setScan({ loading: false, data: null, error: cause?.payload?.message || cause?.message || t('deleteFailed') });
        }
      }, [t]);
      const openConfirm = () => {
        setConfirming(true); startScan([...selected]);
      };
      const closeConfirm = useCallback(() => setConfirming(false), []); const scanned = scan?.data ?? null;
      return { confirming, scan, scanned, openConfirm, closeConfirm, items };
    }

    function useDeepScope(scanned) {
      const [deep, setDeep] = useState({ files: true, attachments: true, requestImages: false });
      const [excluded, setExcluded] = useState(() => new Set()); const [showFiles, setShowFiles] = useState(false);
      const artifacts = scanned?.artifacts ?? [];
      const keptFiles = artifacts.filter((file) => !excluded.has(file.path));
      const keptBytes = keptFiles.reduce((sum, file) => sum + file.bytes, 0);
      const orphanCount = scanned?.attachments?.orphanObjects ?? 0;
      const orphanBytes = scanned?.attachments?.orphanBytes ?? 0;
      const scheduleCount = scanned?.schedules?.count ?? 0; const cacheBytes = scanned?.requestImages?.bytes ?? 0;
      const onToggleFile = (filePath) => {
        setExcluded((current) => {
          const next = new Set(current); if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
          return next;
        });
      };
      return { deep, setDeep, excluded, onToggleFile, showFiles, setShowFiles, artifacts, keptFiles, keptBytes,
        orphanCount, orphanBytes, scheduleCount, cacheBytes };
    }

    function scopeTotals(keep, deep, selectedBytes) {
      const files = deep.files ? keep.keptBytes : 0;
      const attachments = deep.attachments && keep.orphanCount > 0 ? keep.orphanBytes : 0;
      const cache = deep.requestImages && keep.cacheBytes > 0 ? keep.cacheBytes : 0;
      return selectedBytes + files + attachments + cache;
    }

    function describeFailure(items, t, payload) {
      const titleOf = (id) => items.find((entry) => entry.id === id)?.title || id; const lines = [];
      for (const entry of payload?.active ?? []) {
        const labels = (entry.kinds ?? []).map((kind) => activityLabel(t, kind)).join('、');
        lines.push(`${titleOf(entry.id)} — ${labels || t('live')}`);
      }
      for (const entry of payload?.results ?? []) {
        if (!entry || entry.ok) continue;
        const labels = (entry.activity ?? []).map((kind) => activityLabel(t, kind)).join('、');
        const reason = entry.code === 'session-active' ? labels || t('live') : entry.message || entry.code || t('deleteFailed');
        lines.push(`${titleOf(entry.id)} — ${reason}`);
      }
      return lines.slice(0, 8);
    }

    function noticeOfDelete(t, result, ids) {
      const deferred = result.deferred?.length ?? 0;
      let text = `${t('noticeDeleted')} ${result.deleted ?? ids.length} ${t('countUnit')} · ${t('noticeFreed')} ${formatBytes(result.removedBytes)}`
        + (deferred > 0 ? fill(t('deferredSuffix'), { n: deferred }) : '');
      if (result.artifacts?.deleted > 0) {
        text += ` · ${fill(t('noticeFiles'), { n: result.artifacts.deleted, size: formatBytes(result.artifacts.bytes) })}`;
      }
      if (result.schedules?.deleted > 0) text += ` · ${fill(t('noticeSchedules'), { n: result.schedules.deleted })}`;
      if (result.gc?.removedObjects > 0) {
        text += ` · ${fill(t('noticeAttachments'), { n: result.gc.removedObjects, size: formatBytes(result.gc.removedBytes) })}`;
      }
      if (result.gc?.requestImages?.removedFiles > 0) {
        text += ` · ${fill(t('noticeCache'), { size: formatBytes(result.gc.requestImages.bytes) })}`;
      }
      return text;
    }

    function deleteDetails(t, result) {
      const details = [];
      for (const entry of result.artifacts?.results ?? []) {
        if (entry?.ok) continue;
        details.push(`${entry.path} — ${entry.code || entry.message || t('deleteFailed')}`);
      }
      for (const entry of result.schedules?.failures ?? []) details.push(`${entry.id} — ${entry.message}`);
      if (result.gc?.blocked) details.push(`${t('deepAttachments')} — ${result.gc.message || result.gc.blocked}`);
      return details;
    }

    function useDeleteRun({ ctx, t, selected, setSelected, scope, closeConfirm, setNotice, load }) {
      const [busy, setBusy] = useState(false);
      const runDelete = async () => {
        const ids = [...selected];
        const body = {
          sessionIds: ids,
          // A failed scan means the attachment picture is unknown: never sweep
          // blind, only the explicitly reviewed categories go through.
          attachments: Boolean(scope.scanned && scope.deep.attachments), requestImages: scope.deep.requestImages,
        };
        // `everything` lets the Host re-derive the set from logs that are still
        // readable instead of trusting a list the browser built.
        if (scope.scanned && scope.deep.files && scope.excluded.size === 0) body.everything = true;
        else if (scope.scanned && scope.deep.files && scope.keptFiles.length > 0) body.files = scope.keptFiles.map((file) => file.path);
        closeConfirm(); setBusy(true); setNotice(null);
        try {
          const result = await request('/delete', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          if (result?.ok) {
            setNotice({ kind: 'ok', text: noticeOfDelete(t, result, ids), details: deleteDetails(t, result) });
            setSelected(new Set());
          } else {
            setNotice({
              kind: 'error', text: `${t('noticeFailed')}：${result?.message || t('deleteFailed')}`,
              details: describeFailure(scope.items, t, result),
            });
          }
          // The sidebar keeps its own baseline: a host-side removal produces no
          // increment the client consumes, so re-pull the session list too.
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
          if (sessions && typeof sessions.refresh === 'function') await sessions.refresh(); await load();
        } catch (cause) {
          const payload = cause?.payload;
          setNotice({
            kind: 'error', text: `${t('deleteFailed')}：${payload?.message || cause?.message || ''}`,
            details: describeFailure(scope.items, t, payload),
          });
        } finally {
          setBusy(false);
        }
      };
      return { busy, runDelete };
    }

    function useGcFlow({ t, load, setNotice }) {
      const [gc, setGc] = useState(null);
      const failed = (cause) => setNotice({ kind: 'error', text: fill(t('orphanGcFailed'), { message: cause?.message || '' }) });
      const runGcDryRun = async () => {
        setNotice(null);
        setGc({ busy: true, pending: null });
        try {
          const result = await request('/gc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (!result?.ok) {
            setNotice({ kind: 'error', text: fill(t('orphanGcFailed'), { message: result?.message || result?.code || '' }) });
            setGc(null); return;
          }
          if ((result.orphanObjects ?? 0) === 0) {
            setNotice({ kind: 'ok', text: t('orphanGcNone') });
            setGc(null); return;
          }
          setGc({ busy: false, pending: result });
        } catch (cause) {
          setGc(null); failed(cause);
        }
      };
      const runGc = async () => {
        setGc({ busy: true, pending: null });
        try {
          const result = await request('/gc', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dryRun: false, requestImages: true }),
          });
          if (!result?.ok) {
            setNotice({ kind: 'error', text: fill(t('orphanGcFailed'), { message: result?.message || result?.code || '' }) });
          } else {
            setNotice({ kind: 'ok', text: fill(t('orphanGcDone'), {
              n: result.removedObjects ?? 0,
              size: formatBytes((result.removedBytes ?? 0) + (result.requestImages?.bytes ?? 0)),
            }) });
          }
          setGc(null); await load();
        } catch (cause) {
          setGc(null); failed(cause);
        }
      };
      return { gc, runGcDryRun, runGc };
    }

    function leftoverFreeOf(plan, sel) {
      if (!plan || !sel) return 0; let sum = 0;
      for (const file of plan.files) if (!file.changed && sel.files.has(file.path)) sum += file.bytes;
      if (sel.logs) sum += plan.logs.reduce((acc, entry) => acc + (entry.bytes ?? 0), 0);
      if (sel.caches) sum += plan.caches.reduce((acc, entry) => acc + (entry.bytes ?? 0), 0);
      if (sel.attachments) sum += plan.attachments?.orphanBytes ?? 0;
      if (sel.requestImages) sum += plan.requestImages?.bytes ?? 0; return sum;
    }

    function leftoverSelection(plan) {
      return {
        files: new Set(plan.files.filter((file) => !file.changed).map((file) => file.path)),
        logs: plan.logs.length > 0, caches: plan.caches.length > 0, accounting: plan.accounting.length > 0,
        archived: plan.archived.length > 0, attachments: (plan.attachments?.orphanObjects ?? 0) > 0,
        requestImages: (plan.requestImages?.files ?? 0) > 0,
      };
    }

    function useLeftoverFlow({ t, load, setNotice }) {
      const [leftovers, setLeftovers] = useState(null); const [leftoverSel, setLeftoverSel] = useState(null);
      const failText = (cause) => `${t('deleteFailed')}：${cause?.payload?.message || cause?.message || ''}`;
      const scanLeftovers = async () => {
        setNotice(null);
        setLeftovers({ busy: true, plan: null });
        setLeftoverSel(null);
        try {
          const plan = await request('/leftovers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          const empty = plan.files.length === 0 && plan.logs.length === 0 && plan.caches.length === 0
            && plan.accounting.length === 0 && plan.archived.length === 0
            && (plan.attachments?.orphanObjects ?? 0) === 0 && (plan.requestImages?.files ?? 0) === 0;
          if (empty) {
            setLeftovers(null); setLeftoverSel(null);
            setNotice({ kind: 'ok', text: t('leftoversEmpty') });
            return;
          }
          setLeftovers({ busy: false, plan });
          setLeftoverSel(leftoverSelection(plan));
        } catch (cause) {
          setLeftovers(null); setLeftoverSel(null);
          setNotice({ kind: 'error', text: failText(cause) });
        }
      };
      const toggleLeftoverFile = (filePath) => {
        setLeftoverSel((current) => {
          if (!current) return current; const files = new Set(current.files);
          if (files.has(filePath)) files.delete(filePath); else files.add(filePath);
          return { ...current, files };
        });
      };
      const setLeftoverFlag = (key, value) => {
        setLeftoverSel((current) => (current ? { ...current, [key]: value } : current));
      };
      const runLeftoverPurge = async () => {
        if (!leftoverSel) return;
        setLeftovers((current) => ({ busy: true, plan: current?.plan ?? null }));
        try {
          const result = await request('/purge-leftovers', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              files: [...leftoverSel.files], logs: leftoverSel.logs, caches: leftoverSel.caches,
              accounting: leftoverSel.accounting, archived: leftoverSel.archived,
              attachments: leftoverSel.attachments, requestImages: leftoverSel.requestImages,
            }),
          });
          setNotice({
            kind: result?.ok === false ? 'error' : 'ok',
            text: result?.ok === false ? `${t('deleteFailed')}：${result?.message || ''}` : fill(t('leftoverDone'), { size: formatBytes(result?.bytes ?? 0) }),
          });
          setLeftovers(null); setLeftoverSel(null); await load();
        } catch (cause) {
          setLeftovers(null); setLeftoverSel(null);
          setNotice({ kind: 'error', text: failText(cause) });
        }
      };
      const plan = leftovers?.plan ?? null;
      const cancel = () => { setLeftovers(null); setLeftoverSel(null); };
      return { leftovers, plan, sel: leftoverSel, cancel, changed: plan ? plan.files.filter((file) => file.changed).length : 0,
        free: leftoverFreeOf(plan, leftoverSel), scanLeftovers, toggleLeftoverFile, setLeftoverFlag, runLeftoverPurge };
    }

    function useAutoSweep(t) {
      const [status, setStatus] = useState(null); const [checking, setChecking] = useState(false);
      const [busy, setBusy] = useState(''); const [notice, setNotice] = useState('');
      const load = useCallback(async () => {
        try {
          setStatus(await request('/auto'));
        } catch {
          setStatus(null);
        }
      }, []);
      useEffect(() => { load(); }, [load]);
      const check = async () => {
        setChecking(true); setNotice('');
        try {
          const result = await request('/auto/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          setNotice(fill(t('autoChecked'), { n: result?.held?.length ?? 0, skipped: result?.skipped?.length ?? 0 }));
        } catch (cause) {
          setNotice(fill(t('autoCheckFailed'), { message: cause?.message || '' }));
        } finally {
          setChecking(false);
        }
      };
      const restore = async (entryId) => {
        setBusy(entryId); setNotice('');
        try {
          const result = await request('/auto/restore', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryId }),
          });
          setNotice(result?.ok
            ? fill(t('autoRestored'), { n: result.restored?.length ?? 0 })
            : fill(t('autoRestoreFailed'), { message: result?.message || '' }));
        } catch (cause) {
          setNotice(fill(t('autoRestoreFailed'), { message: cause?.message || '' }));
        } finally {
          setBusy(''); await load();
        }
      };
      return { status, checking, busy, notice, load, check, restore };
    }

    function useEscapeKey(confirming, closeConfirm) {
      useEffect(() => {
        if (!confirming) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') closeConfirm();
        };
        window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
      }, [confirming, closeConfirm]);
    }

    // ---------- page ----------

    function createPanel(ctx, t, autoHook) {
      return function ArchivedPurgePanel() {
        const store = useArchiveData(t); const items = store.data?.items ?? []; const groups = useGroups(items, t);
        const [notice, setNotice] = useState(null); const clearNotice = useCallback(() => setNotice(null), []);
        const selection = useSelection(items, store.selected, store.setSelected, clearNotice);
        const scanFlow = useScanFlow({ t, selected: store.selected, items });
        const deep = useDeepScope(scanFlow.scanned);
        const scope = { ...scanFlow, ...deep, items };
        scope.totalFree = scopeTotals(deep, deep.deep, 0) + selectedBytesOf(items, store.selected);
        const flow = useDeleteRun({ ctx, t, selected: store.selected, setSelected: store.setSelected,
          scope, closeConfirm: scanFlow.closeConfirm, setNotice, load: store.load });
        const gcFlow = useGcFlow({ t, load: store.load, setNotice });
        const leftoverFlow = useLeftoverFlow({ t, load: store.load, setNotice });
        const auto = autoHook(t); const masterRef = useRef(null);
        useEscapeKey(scanFlow.confirming, scanFlow.closeConfirm);
        useEffect(() => {
          if (masterRef.current) masterRef.current.indeterminate = selection.someSelected;
        }, [selection.someSelected]);
        const selectedCount = store.selected.size; const selectedBytes = selectedBytesOf(items, store.selected);
        scope.totalFree = scopeTotals(deep, deep.deep, selectedBytes);
        return h('div', { className: 'ap-root' },
          h('style', null, CSS),
          h(PanelHeader, { t, data: store.data, total: items.length,
            activeCount: items.filter((item) => item.active).length, selectedCount, selectedBytes }),
          h(AutoCard, { t, auto }),
          h(Toolbar, { t, masterRef, allSelected: selection.allSelected, onToggleAll: selection.toggleAll,
            total: items.length, busy: flow.busy, selectedCount, loading: store.loading,
            onLeftovers: leftoverFlow.scanLeftovers, onGc: gcFlow.runGcDryRun, onRefresh: store.load,
            onDelete: scanFlow.openConfirm, leftoversBusy: leftoverFlow.leftovers?.busy === true, gcBusy: gcFlow.gc?.busy === true }),
          h(NoticeView, { t, error: store.error, notice }),
          h(GcPrompt, { t, gc: gcFlow.gc, onConfirm: gcFlow.runGc, onCancel: () => gcFlow.setGc?.(null) }),
          h(NoticeView, { t, error: '', notice: leftoverFlow.leftovers?.busy ? { kind: 'info', text: t('leftoversScanning') } : null }),
          h(LeftoverPanel, { t, plan: leftoverFlow.plan, sel: leftoverFlow.sel, changed: leftoverFlow.changed,
            free: leftoverFlow.free, onToggleFile: leftoverFlow.toggleLeftoverFile, onFlag: leftoverFlow.setLeftoverFlag,
            onCancel: () => { leftoverFlow.cancel(); }, onPurge: leftoverFlow.runLeftoverPurge }),
          (store.data?.pendingFinalize ?? 0) > 0
            ? h('div', { className: 'ap-meta' }, fill(t('pendingFinalizeHint'), { n: store.data.pendingFinalize }))
            : null,
          h(ArchiveList, { t, loading: store.loading, total: items.length, groups, selected: store.selected,
            onToggle: selection.toggle, allInGroup: selection.allInGroup, onToggleGroup: selection.toggleGroup }),
          h(ConfirmDialog, { t, scope, selectedBytes,
            dialog: { open: scanFlow.confirming, close: scanFlow.closeConfirm, run: flow.runDelete, busy: flow.busy, selectedCount } }),
        );
      };
    }

    function selectedBytesOf(items, selected) {
      return items.reduce((sum, item) => (selected.has(item.id) ? sum + item.sizeBytes : sum), 0);
    }

    function reportMountError(error) {
      try {
        console.error('[dsh-archived-purge] client mount failed', error);
      } catch {
        /* console unavailable */
      }
      try {
        fetch(ROUTE + '/client-error', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: String(error?.message ?? error), stack: String(error?.stack ?? ''),
          }),
        }).catch(() => {});
      } catch {
        /* reporting is best-effort */
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh, ...AUTO_ZH }, en: { ...en, ...AUTO_EN } }), 'archived-purge: dictionaries');
          const t = ctx.locale.bind(NS); const Panel = createPanel(ctx, t, useAutoSweep);
          // `settings.section` is declared by the settings shell entry, which may
          // activate after this plugin. Registering straight away throws inside
          // SlotCore ("slot ... is not declared") and fails the whole web boot, so
          // wait for the declaration and re-register whenever it returns.
          ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'archived-purge', order: 25, label: () => t('nav'), locale: NS,
          }, Panel)), 'archived-purge: settings section');
        } catch (error) {
          reportMountError(error);
        }
      },
    };
  },
});
