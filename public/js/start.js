'use strict';

(async () => {
  const user = await loadMe();
  initTaskbar({ title: 'Willkommen', user });

  if (user) {
    document.getElementById('hello-name').textContent = user.displayName;
    document.getElementById('logged-in').hidden = false;
    document.getElementById('logged-out').hidden = true;
    return;
  }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const selectTab = (tab) => {
    for (const t of tabs) {
      const active = t === tab;
      t.setAttribute('aria-selected', String(active));
      t.tabIndex = active ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !active;
    }
    document.getElementById(tab.getAttribute('aria-controls')).querySelector('input')?.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      selectTab(next);
    });
  });

  const handle = (form, url) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await busy(form, () => api('POST', url, formValues(form)));
        location.href = '/meine-listen';
      } catch (err) {
        await showError(err);
        form.querySelector('input')?.focus();
      }
    });
  };
  handle(document.getElementById('login-form'), '/api/login');
  handle(document.getElementById('register-form'), '/api/register');
})();
