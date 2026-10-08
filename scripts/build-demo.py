#!/usr/bin/env python3
"""Build the static demo (GitHub Pages) from public/ — rewrites absolute URLs to relative."""
import os, re, shutil, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public')
DST = os.path.join(ROOT, 'demo')

shutil.rmtree(DST, ignore_errors=True)
shutil.copytree(SRC, DST)
shutil.copy(os.path.join(ROOT, 'seed.json'), os.path.join(DST, 'seed.json'))

# static demo config (no backend)
with open(os.path.join(DST, 'js', 'config.js'), 'w') as f:
    f.write('window.APP_CONFIG = {"api": null, "demo": true};\n')
with open(os.path.join(DST, '.nojekyll'), 'w') as f:
    f.write('')

def patch(path, subs):
    with open(path, encoding='utf-8') as f:
        t = f.read()
    for old, new in subs:
        t = t.replace(old, new)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(t)

COMMON = [
    ('href="/css/style.css"', 'href="css/style.css"'),
    ('src="/js/config.js"', 'src="js/config.js"'),
    ('src="/js/store.js"', 'src="js/store.js"'),
    ('src="/js/app.js"', 'src="js/app.js"'),
    ('href="/course"', 'href="course.html"'),
    ('href="/login"', 'href="login.html"'),
    ('href="/register"', 'href="register.html"'),
    ('href="/forgot"', 'href="forgot.html"'),
    ('href="/student"', 'href="student.html"'),
    ('href="/admin"', 'href="admin.html"'),
    ('href="/"', 'href="index.html"'),
    ('href="/#pricing"', 'href="index.html#pricing"'),
    ("href='/lesson/' +", "href='lesson.html?id=' +"),
    ('"/lesson/" +', '"lesson.html?id=" +'),
    ("'/lesson/' +", "'lesson.html?id=' +"),
]

for f in glob.glob(os.path.join(DST, '*.html')):
    patch(f, COMMON)

# app.js demo patches: relative navigation + next-param resolver
APP_PATCH = '''
// ---- demo-only: resolve absolute app paths to relative demo pages ----
App.resolve = function (p) {
  if (!p) return null;
  if (/^(https?:|#|mailto:)/.test(p)) return p;
  const m = p.match(/^\\/lesson\\/(\\d+)/); if (m) return 'lesson.html?id=' + m[1];
  const map = { '/': 'index.html', '/course': 'course.html', '/login': 'login.html',
    '/register': 'register.html', '/forgot': 'forgot.html', '/reset': 'reset.html',
    '/student': 'student.html', '/admin': 'admin.html' };
  const base = p.split('?')[0].split('#')[0];
  if (map[base]) return map[base] + p.slice(base.length);
  return p;
};
(function () {
  const _orig = App.requireLoginRedirect;
  App.requireLoginRedirect = function () {
    const next = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
    location.href = 'login.html?next=' + next;
  };
})();
'''
with open(os.path.join(DST, 'js', 'app.js'), 'a', encoding='utf-8') as f:
    f.write(APP_PATCH)

# pages: route next/login/logout/buy navigation through App.resolve
for f in ['login.html', 'register.html']:
    p = os.path.join(DST, f)
    patch(p, [
        ("location.href = params.get('next') ||", "location.href = App.resolve(params.get('next')) ||"),
        ("location.href = '/register?enroll=1'", "location.href = 'register.html?enroll=1'"),
    ])

p = os.path.join(DST, 'js', 'app.js')
patch(p, [
    ("location.href = '/';", "location.href = 'index.html';"),
    ("[['/', 'الرئيسية'], ['/course', 'المنهج']]",
     "[['index.html', 'الرئيسية'], ['course.html', 'المنهج']]"),
    ('<a href="/admin">', '<a href="admin.html">'),
    ('<a href="/student">', '<a href="student.html">'),
    ('<a class="btn btn-ghost btn-sm" href="/login">', '<a class="btn btn-ghost btn-sm" href="login.html">'),
    ('<a class="btn btn-primary btn-sm" href="/register">', '<a class="btn btn-primary btn-sm" href="register.html">'),
    ('<a class="logo" href="/">', '<a class="logo" href="index.html">'),
])

# lesson.html: read id from ?id= (demo) as well as path
p = os.path.join(DST, 'lesson.html')
patch(p, [
    ("const id = location.pathname.split('/').pop();",
     "const id = new URLSearchParams(location.search).get('id') || location.pathname.split('/').pop().split('.')[0];"),
    ("location.href = '/lesson/' + next.id;", "location.href = 'lesson.html?id=' + next.id;"),
])

# index.html demo buy flow
p = os.path.join(DST, 'index.html')
patch(p, [("location.href = '/register?enroll=1';", "location.href = 'register.html?enroll=1';")])

print('demo built at', DST)
