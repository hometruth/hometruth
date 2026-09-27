/**
 * Connection loss marks cached content stale; only an explicit click navigates.
 *
 * The page opens no connection of its own for this: it reads the state
 * client's one stream (`ht.state`, installed by the theme entry). That
 * stream's `hello` names the worker generation, so a page from an older
 * worker shows the refresh notice, and its loss is what marks the page
 * disconnected. A second stream per tab would halve how many tabs the
 * browser's six-connection limit lets stay usable.
 */
export function runtimeUpdateScript(version: string): string {
  return String.raw`
    (() => {
      const version = ${JSON.stringify(version).replaceAll("<", "\\u003c")};
      const generation = version.slice(0, version.lastIndexOf(':'));
      const main = document.querySelector('main');
      const connection = document.createElement('section');
      connection.className = 'runtime-connection';
      connection.hidden = true;
      connection.setAttribute('data-runtime-connection', '');
      connection.setAttribute('role', 'status');
      connection.setAttribute('aria-live', 'polite');
      const heading = document.createElement('h1');
      const detail = document.createElement('p');
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'btn';
      refresh.textContent = ht.t('action.refresh');
      connection.append(heading, detail, refresh);
      document.body.prepend(connection);
      let notice, noticeMessage, noticeRefresh;
      let active = true;
      const unavailable = (checking = false) => {
        document.documentElement.setAttribute('data-runtime-state', 'unavailable');
        heading.textContent = ht.t(checking ? 'status.serverConnecting' : 'status.serverUnavailable');
        detail.textContent = ht.t('status.serverUnavailableDetail');
        connection.hidden = false;
      };
      const available = () => {
        document.documentElement.removeAttribute('data-runtime-state');
        connection.hidden = true;
      };
      const reload = () => {
        active = false;
        // A failed navigation may leave this document on screen.
        unavailable(true);
        location.reload();
      };
      refresh.addEventListener('click', reload);
      const showNotice = (message, canRefresh = true) => {
        if (!notice) {
          notice = document.createElement('div');
          notice.className = 'bar runtime-update';
          notice.setAttribute('role', 'status');
          noticeMessage = document.createElement('span');
          noticeRefresh = document.createElement('button');
          noticeRefresh.type = 'button';
          noticeRefresh.className = 'btn';
          noticeRefresh.textContent = ht.t('action.refresh');
          noticeRefresh.addEventListener('click', reload);
          notice.append(noticeMessage, noticeRefresh);
          main.prepend(notice);
        }
        noticeMessage.textContent = ht.t(message);
        noticeRefresh.hidden = !canRefresh;
        notice.hidden = false;
      };
      // Browser internet-connectivity events do not describe localhost health;
      // only the page's own stream does. A hidden page holds no stream and keeps
      // what it shows, so returning to a tab never flashes a connecting notice.
      const update = (state) => {
        if (!active) return;
        if (state === 'disconnected') { unavailable(true); return; }
        if (state !== 'live') return;
        available();
        // A page rendered before services were up is outdated once they are.
        if (ht.state.generation !== generation || version.endsWith(':ui')) showNotice('status.pageUpdated');
        else if (notice) notice.hidden = true;
      };
      const attach = () => {
        // No state client means the page's module never loaded: the server went away mid-load.
        if (!ht.state) { unavailable(); return; }
        ht.state.onConnection(update);
        update(ht.state.connection);
      };
      if (version.endsWith(':ui')) showNotice('status.serverStarting', false);
      // The theme entry is a module script, so it has run by DOMContentLoaded.
      if (ht.state) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
    })();
  `;
}
