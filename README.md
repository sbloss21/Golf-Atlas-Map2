[README.md](https://github.com/user-attachments/files/22855982/README.md)
# Golf Atlas – USA Only Map (Starter Package)

This is a clean starter you can drop into a new GitHub repo and deploy with GitHub Pages.

## Files
- `index.html` – Full-screen Leaflet map (light theme), **locked to the USA** (incl. AK & HI), with a visual **mask** hiding everything outside the US. Loads markers from a CSV.
- `.nojekyll` – Prevents GitHub Pages from running Jekyll (keeps things simple).

## Deploy on GitHub Pages
1. Create a repo (e.g., `Golf-Atlas-Map`).
2. Upload the contents of this zip to the repo **root** (same level as README).
3. In **Settings → Pages**, set:
   - **Source:** Deploy from a branch
   - **Branch:** `main` (or default) — **Folder:** `/ (root)`
4. Wait ~30–60s, then open:  
   `https://YOUR-USERNAME.github.io/YOUR-REPO/?csv=URL_ENCODED_CSV`

### Example (your live Sheet)
```
https://sbloss21.github.io/Golf-Atlas-Map/?csv=https%3A%2F%2Fdocs.google.com%2Fspreadsheets%2Fd%2Fe%2F2PACX-1vT-nZvG7m9sUkOu0spxVTVGcM311qlgGSjnFgRDQr-l6nfs1cPFNrGBXO0ZDzMIQg%2Fpub%3Fgid%3D2124679046%26single%3Dtrue%26output%3Dcsv
```

## Optional
- Add a local `courses.csv` file next to `index.html` and omit the `?csv=...` param.
- Customize popup colors in `index.html` (search for `.popup-` styles).
