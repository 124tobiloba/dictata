# Dictata site

Static landing page for <https://github.com/124tobiloba/dictata>. Plain HTML and CSS,
no build step, no external requests.

## Deploy on Vercel

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project** and import the repository.
3. Set **Root Directory** to `site`.
4. Framework preset: **Other**. Build command: none. Output directory: `.`
5. Deploy.

`vercel.json` is not required; Vercel serves the three files as-is.

## Preview locally

```powershell
npx serve site
```

Or open `site/index.html` directly in a browser.
