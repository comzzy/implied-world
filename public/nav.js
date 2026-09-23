(function () {
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!header || !toggle || !nav) return;

  function setOpen(open) {
    header.classList.toggle('nav-open', open);
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function isOpen() {
    return header.classList.contains('nav-open');
  }

  toggle.addEventListener('click', () => {
    setOpen(!isOpen());
  });

  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });

  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 860px)').matches && isOpen()) {
      setOpen(false);
    }
  });
})();
