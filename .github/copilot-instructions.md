# GitHub Copilot Instructions for DocuWeaver

## Project Overview
DocuWeaver is a Django-based PDF drawing alignment and asset overlay application with a Fabric.js canvas editor.

## Code Organization

### JavaScript Modules
The canvas editor is split into modular files in `static/js/editor/`:
- `namespace.js` - Shared state and utilities (load first)
- `viewport.js` - Zoom, pan, rotation
- `tools.js` - Tool mode handlers
- `canvas_init.js` - Canvas initialization
- `assets.js` - Asset rendering and coordinates
- `links.js` - Link layer rendering
- `sheets.js` - Sheet management
- `osm.js` - OpenStreetMap tiles
- `measurements.js` - Measurement tool UI
- `main.js` - Entry point (load last)

All modules use the `window.DocuWeaver` namespace pattern.

## Important Guidelines

### DO NOT Create Documentation Files
- **Never create `.md` files** in the project root to document changes, features, or fixes
- These files are not referenced by AI tools and clutter the repository
- If temporary notes are needed during development, add them to `.gitignore` first
- Clean up any temporary files before completing a feature

### Preferred Practices
- Add inline code comments for complex logic
- Update existing README.md only for significant user-facing changes
- Use git commit messages to document what changed and why
- Keep the codebase self-documenting with clear function/variable names

### File Naming
- JavaScript modules: `lowercase_with_underscores.js`
- Python files: `lowercase_with_underscores.py`
- Templates: `lowercase.html`

### Testing
- Run tests with `pytest` from the project root
- Test files are in `drawings/tests.py`
