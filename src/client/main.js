/* ============================================================================
 * main.js — bundle entry. Registers the locale dictionaries, the shared base
 * stylesheet, the standalone statistics page, its sidebar panel icon, and the
 * replacement for the shipped `usage` composer dock control.
 * This file is LAST in the build order; the factory returns its plugin object.
 * ========================================================================== */

function DshTokenPanelIcon(props) {
  return h(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      }
    },
    h(DshIcon, { name: 'chart', size: (props && props.size) || 16 })
  );
}

function DshTokenApply(ctx) {
  /* ------------------------------------------------------------- locale --- */
  var dicts = dshtokenMergeDicts([
    DSHTOKEN_I18N,
    typeof DSHTOKEN_I18N_CHART === 'undefined' ? null : DSHTOKEN_I18N_CHART,
    typeof DSHTOKEN_I18N_PAGE === 'undefined' ? null : DSHTOKEN_I18N_PAGE,
    typeof DSHTOKEN_I18N_DOCK === 'undefined' ? null : DSHTOKEN_I18N_DOCK
  ]);
  dshtokenSetDicts(dicts);

  var locale = ctx.get('locale');
  if (locale && typeof locale.getLocale === 'function') {
    try {
      dshtokenSetActiveLocale(locale.getLocale().active);
    } catch (error) {
      /* keep default locale */
    }
  }
  if (locale && typeof locale.register === 'function') {
    ctx.effect(
      function () {
        return locale.register(DSHTOKEN_NS, dicts);
      },
      'dshtoken: locale dictionaries'
    );
  }
  ctx.on('locale/change', function (snapshot) {
    dshtokenNotifyLocale(snapshot && snapshot.active);
  });

  /* ------------------------------------------------------------- styles --- */
  ctx.effect(
    function () {
      if (typeof document === 'undefined' || !document.head) return undefined;
      if (document.querySelector('style[data-dshtoken-base="1"]')) return undefined;
      var style = document.createElement('style');
      style.setAttribute('data-dshtoken-base', '1');
      style.textContent = DSHTOKEN_BASE_CSS;
      document.head.appendChild(style);
      return function () {
        try {
          style.remove();
        } catch (error) {
          /* already detached */
        }
      };
    },
    'dshtoken: base styles'
  );

  /* --------------------------------------------------------- navigation --- */
  function openStats() {
    try {
      var layout = ctx.get('layout');
      if (layout && typeof layout.selectPanel === 'function') {
        layout.selectPanel(DSHTOKEN_PANEL);
        return true;
      }
    } catch (error) {
      try {
        console.error('[dshtoken] openStats failed', error);
      } catch (ignored) {
        /* ignore */
      }
    }
    return false;
  }

  function openSession(sessionId) {
    if (!sessionId) return;
    try {
      var uiWorkspace = ctx.get('uiWorkspace');
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        uiWorkspace.openSession(sessionId);
      }
    } catch (error) {
      try {
        console.error('[dshtoken] openSession failed', error);
      } catch (ignored) {
        /* ignore */
      }
    }
  }

  var statsChangedListeners = [];

  function subscribeStatsChanged(listener) {
    if (typeof listener !== 'function') return function () {};
    statsChangedListeners.push(listener);
    return function () {
      var index = statsChangedListeners.indexOf(listener);
      if (index >= 0) statsChangedListeners.splice(index, 1);
    };
  }

  function notifyStatsChanged() {
    var listeners = statsChangedListeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (error) {
        /* listener failures must not break others */
      }
    }
  }

  /* -------------------------------------------------------- slot wiring --- */
  var slots = ctx.slots;

  function registerSlot(slotName, callback, label) {
    ctx.effect(
      function () {
        return slots.inject(slotName, callback);
      },
      'dshtoken: ' + label
    );
  }

  /* Injected registration props: the slot system spreads the returned object
   * onto the component props (prompt-optimizer/cosplay precedent), so expose the
   * face both as top-level keys and nested under `inject` for older/other readers. */
  function navigationFace() {
    var face = {
      openSession: openSession,
      openStats: openStats,
      notifyStatsChanged: notifyStatsChanged,
      subscribeStatsChanged: subscribeStatsChanged
    };
    face.inject = face;
    return face;
  }

  registerSlot(
    'main',
    function () {
      return slots.register(
        {
          name: 'main',
          key: DSHTOKEN_PANEL,
          locale: DSHTOKEN_NS,
          inject: navigationFace
        },
        DshTokenPage
      );
    },
    'statistics page'
  );

  registerSlot(
    'sidebar.panellist',
    function () {
      return slots.register(
        {
          name: 'sidebar.panellist',
          id: DSHTOKEN_PANEL,
          order: 20,
          priority: 0,
          label: function () {
            return dshtokenT('panel.title');
          }
        },
        DshTokenPanelIcon
      );
    },
    'sidebar panel icon'
  );

  registerSlot(
    'conversation.composer.dock',
    function () {
      return slots.register(
        {
          name: 'conversation.composer.dock',
          id: 'usage',
          order: 1,
          priority: -10,
          locale: DSHTOKEN_NS,
          inject: navigationFace
        },
        DshTokenUsageDock
      );
    },
    'composer usage chip'
  );
}

return { inject: ['slots', 'locale'], apply: DshTokenApply };
