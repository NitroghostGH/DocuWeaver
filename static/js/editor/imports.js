/**
 * DocuWeaver Canvas Editor - Imports Module
 *
 * Handles upload modals, CSV import (assets + links), import batches,
 * single-item deletion, and report download.
 *
 * Depends on: namespace.js
 *
 * Cross-module calls (guarded with typeof checks):
 *   - loadProjectData()        (main.js)
 *   - renderAssetList()        (assets.js)
 *   - refreshAssets()          (assets.js)
 *   - renderLinkList()         (links.js)
 *   - renderLinkGroupList()    (layers.js)
 *   - renderImportBatches()    (self — called after mutations)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // ==================== Private Module State ====================

    let importCsvFile = null;
    let importCsvHeaders = [];
    let importColumnPresets = {};

    let importLinksCsvFile = null;
    let importLinksCsvHeaders = [];

    // ==================== Upload Modal ====================

    function showUploadModal() {
        document.getElementById('uploadModal').style.display = 'block';
    }

    function hideUploadModal() {
        document.getElementById('uploadModal').style.display = 'none';
    }

    // ==================== Asset CSV Import ====================

    function showImportModal() {
        document.getElementById('import-step-1').style.display = 'block';
        document.getElementById('import-step-2').style.display = 'none';
        document.getElementById('import-csv-file').value = '';
        importCsvFile = null;
        importCsvHeaders = [];
        document.getElementById('importModal').style.display = 'block';
    }

    function hideImportModal() {
        document.getElementById('importModal').style.display = 'none';
    }

    async function importStepNext() {
        var fileInput = document.getElementById('import-csv-file');
        if (!fileInput.files.length) {
            alert('Please select a CSV file.');
            return;
        }

        importCsvFile = fileInput.files[0];

        try {
            var text = await importCsvFile.text();
            var firstLine = text.split('\n')[0].trim();
            importCsvHeaders = firstLine.split(',').map(function(h) {
                return h.trim().replace(/^["']|["']$/g, '');
            });

            if (importCsvHeaders.length === 0) {
                alert('Could not parse CSV headers.');
                return;
            }
        } catch (err) {
            alert('Error reading CSV file: ' + err.message);
            return;
        }

        // Fetch presets from admin
        try {
            var resp = await fetch('/api/column-presets/');
            if (resp.ok) {
                importColumnPresets = await resp.json();
            }
        } catch (err) {
            console.error('Could not fetch column presets:', err);
            importColumnPresets = {};
        }

        var preview = document.getElementById('import-csv-preview');
        preview.textContent = 'Detected columns: ' + importCsvHeaders.join(', ');

        // Check localStorage for remembered mapping
        var mappingKey = 'csvMapping_' + importCsvHeaders.slice().sort().join('|');
        var rememberedMapping = null;
        try {
            var saved = localStorage.getItem(mappingKey);
            if (saved) rememberedMapping = JSON.parse(saved);
        } catch (e) { /* ignore */ }

        var roles = [
            { id: 'map-asset-id', role: 'asset_id', required: true },
            { id: 'map-asset-type', role: 'asset_type', required: true },
            { id: 'map-x', role: 'x', required: true },
            { id: 'map-y', role: 'y', required: true },
            { id: 'map-name', role: 'name', required: false }
        ];

        roles.forEach(function(item) {
            var select = document.getElementById(item.id);
            select.innerHTML = '';

            if (!item.required) {
                var noneOpt = document.createElement('option');
                noneOpt.value = '';
                noneOpt.textContent = '-- None --';
                select.appendChild(noneOpt);
            }

            importCsvHeaders.forEach(function(header) {
                var opt = document.createElement('option');
                opt.value = header;
                opt.textContent = header;
                select.appendChild(opt);
            });

            var matched = false;
            if (rememberedMapping && rememberedMapping[item.role] && importCsvHeaders.includes(rememberedMapping[item.role])) {
                select.value = rememberedMapping[item.role];
                matched = true;
            }

            if (!matched) {
                var presetNames = importColumnPresets[item.role] || [];
                for (var i = 0; i < presetNames.length; i++) {
                    var match = importCsvHeaders.find(function(h) {
                        return h.toLowerCase() === presetNames[i].toLowerCase();
                    });
                    if (match) {
                        select.value = match;
                        matched = true;
                        break;
                    }
                }
            }

            if (!matched) {
                var fallback = importCsvHeaders.find(function(h) {
                    return h.toLowerCase() === item.role.toLowerCase();
                });
                if (fallback) {
                    select.value = fallback;
                }
            }
        });

        // Restore asset type mode
        if (rememberedMapping && rememberedMapping._assetTypeMode) {
            var radio = document.querySelector('input[name="asset-type-mode"][value="' + rememberedMapping._assetTypeMode + '"]');
            if (radio) radio.checked = true;
            if (rememberedMapping._assetTypeMode === 'fixed' && rememberedMapping._fixedAssetType) {
                document.getElementById('fixed-asset-type').value = rememberedMapping._fixedAssetType;
            }
        } else {
            document.querySelector('input[name="asset-type-mode"][value="column"]').checked = true;
        }
        toggleAssetTypeMode();

        if (rememberedMapping) {
            preview.textContent += ' (using remembered mapping)';
        }

        document.getElementById('import-step-1').style.display = 'none';
        document.getElementById('import-step-2').style.display = 'block';
    }

    function toggleAssetTypeMode() {
        var mode = document.querySelector('input[name="asset-type-mode"]:checked').value;
        document.getElementById('map-asset-type').style.display = mode === 'column' ? '' : 'none';
        document.getElementById('fixed-asset-type').style.display = mode === 'fixed' ? '' : 'none';
    }

    function importStepBack() {
        document.getElementById('import-step-2').style.display = 'none';
        document.getElementById('import-step-1').style.display = 'block';
    }

    async function importWithMapping() {
        if (!importCsvFile) {
            alert('No CSV file selected.');
            return;
        }

        var assetTypeMode = document.querySelector('input[name="asset-type-mode"]:checked').value;

        var mapping = {
            asset_id: document.getElementById('map-asset-id').value,
            x: document.getElementById('map-x').value,
            y: document.getElementById('map-y').value
        };

        if (assetTypeMode === 'column') {
            mapping.asset_type = document.getElementById('map-asset-type').value;
        }

        for (var role in mapping) {
            if (!mapping[role]) {
                alert('Please select a column for "' + role + '".');
                return;
            }
        }

        var nameCol = document.getElementById('map-name').value;
        if (nameCol) {
            mapping.name = nameCol;
        }

        var formData = new FormData();
        formData.append('file', importCsvFile);
        formData.append('column_mapping', JSON.stringify(mapping));

        if (assetTypeMode === 'fixed') {
            formData.append('fixed_asset_type', document.getElementById('fixed-asset-type').value);
        }

        try {
            var response = await fetch('/api/projects/' + PROJECT_ID + '/import-csv/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: formData
            });

            var result = await response.json();
            if (response.ok) {
                try {
                    var mappingKey = 'csvMapping_' + importCsvHeaders.slice().sort().join('|');
                    var saveData = Object.assign({}, mapping, { _assetTypeMode: assetTypeMode });
                    if (assetTypeMode === 'fixed') {
                        saveData._fixedAssetType = document.getElementById('fixed-asset-type').value;
                    }
                    localStorage.setItem(mappingKey, JSON.stringify(saveData));
                } catch (e) { /* ignore storage errors */ }

                alert('Import complete:\n' + result.created + ' created\n' + result.updated + ' updated\n' + result.errors.length + ' errors');
                hideImportModal();
                if (typeof loadProjectData === 'function') loadProjectData();
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Import error:', error);
        }
    }

    // ==================== Link CSV Import ====================

    function showImportLinksModal() {
        document.getElementById('import-links-step-1').style.display = 'block';
        document.getElementById('import-links-step-2').style.display = 'none';
        document.getElementById('import-links-csv-file').value = '';
        importLinksCsvFile = null;
        importLinksCsvHeaders = [];
        document.getElementById('importLinksModal').style.display = 'block';
    }

    function hideImportLinksModal() {
        document.getElementById('importLinksModal').style.display = 'none';
    }

    async function importLinksStepNext() {
        var fileInput = document.getElementById('import-links-csv-file');
        if (!fileInput.files.length) {
            alert('Please select a CSV file.');
            return;
        }

        importLinksCsvFile = fileInput.files[0];

        try {
            var text = await importLinksCsvFile.text();
            var firstLine = text.split('\n')[0].trim();
            importLinksCsvHeaders = firstLine.split(',').map(function(h) {
                return h.trim().replace(/^["']|["']$/g, '');
            });

            if (importLinksCsvHeaders.length === 0) {
                alert('Could not parse CSV headers.');
                return;
            }
        } catch (err) {
            alert('Error reading CSV file: ' + err.message);
            return;
        }

        var preview = document.getElementById('import-links-csv-preview');
        preview.textContent = 'Detected columns: ' + importLinksCsvHeaders.join(', ');

        var roles = [
            { id: 'map-link-id', role: 'link_id', required: true },
            { id: 'map-coordinates', role: 'coordinates', required: true },
            { id: 'map-link-name', role: 'name', required: false },
            { id: 'map-link-type', role: 'link_type', required: false }
        ];

        roles.forEach(function(item) {
            var select = document.getElementById(item.id);
            select.innerHTML = '';

            if (!item.required) {
                var noneOpt = document.createElement('option');
                noneOpt.value = '';
                noneOpt.textContent = '-- None --';
                select.appendChild(noneOpt);
            }

            importLinksCsvHeaders.forEach(function(header) {
                var opt = document.createElement('option');
                opt.value = header;
                opt.textContent = header;
                select.appendChild(opt);
            });

            var match = importLinksCsvHeaders.find(function(h) {
                return h.toLowerCase().includes(item.role.toLowerCase()) ||
                    h.toLowerCase() === item.role.toLowerCase() ||
                    (item.role === 'link_id' && (h.toLowerCase().includes('id') || h.toLowerCase().includes('link'))) ||
                    (item.role === 'coordinates' && (h.toLowerCase().includes('coord') || h.toLowerCase().includes('geom')));
            });
            if (match) {
                select.value = match;
            }
        });

        document.getElementById('import-links-step-1').style.display = 'none';
        document.getElementById('import-links-step-2').style.display = 'block';
    }

    function importLinksStepBack() {
        document.getElementById('import-links-step-2').style.display = 'none';
        document.getElementById('import-links-step-1').style.display = 'block';
    }

    async function importLinksWithMapping() {
        if (!importLinksCsvFile) {
            alert('No CSV file selected.');
            return;
        }

        var mapping = {
            link_id: document.getElementById('map-link-id').value,
            coordinates: document.getElementById('map-coordinates').value
        };

        if (!mapping.link_id || !mapping.coordinates) {
            alert('Please select columns for Link ID and Coordinates.');
            return;
        }

        var nameCol = document.getElementById('map-link-name').value;
        if (nameCol) mapping.name = nameCol;

        var typeCol = document.getElementById('map-link-type').value;
        if (typeCol) mapping.link_type = typeCol;

        var formData = new FormData();
        formData.append('file', importLinksCsvFile);
        formData.append('column_mapping', JSON.stringify(mapping));

        try {
            var response = await fetch('/api/projects/' + PROJECT_ID + '/import-links-csv/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: formData
            });

            var result = await response.json();
            if (response.ok) {
                alert('Link import complete:\n' + result.created + ' created\n' + result.updated + ' updated\n' + result.errors.length + ' errors');
                hideImportLinksModal();
                if (typeof loadProjectData === 'function') loadProjectData();
            } else {
                alert('Error: ' + result.error);
            }
        } catch (error) {
            console.error('Link import error:', error);
        }
    }

    // ==================== Upload Form Handler ====================

    document.addEventListener('DOMContentLoaded', function() {
        var uploadForm = document.getElementById('uploadForm');
        if (uploadForm) {
            uploadForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                var form = this;
                var fileInput = form.querySelector('input[type="file"]');
                var files = Array.from(fileInput.files);

                if (files.length === 0) return;

                var uploadBtn = document.getElementById('uploadBtn');
                var progressDiv = document.getElementById('uploadProgress');
                var currentSpan = document.getElementById('uploadCurrent');
                var totalSpan = document.getElementById('uploadTotal');

                uploadBtn.disabled = true;
                progressDiv.style.display = 'block';
                totalSpan.textContent = files.length;

                var totalSheets = 0;
                var errors = [];

                for (var i = 0; i < files.length; i++) {
                    currentSpan.textContent = i + 1;
                    var file = files[i];

                    // Derive sheet name from filename (strip .pdf extension)
                    var name = file.name.replace(/\.pdf$/i, '');

                    var formData = new FormData();
                    formData.append('pdf_file', file);
                    formData.append('name', name);

                    try {
                        var response = await fetch('/api/projects/' + PROJECT_ID + '/sheets/', {
                            method: 'POST',
                            headers: {
                                'X-CSRFToken': DW.getCSRFToken()
                            },
                            body: formData
                        });

                        if (response.ok) {
                            var result = await response.json();
                            totalSheets += Array.isArray(result) ? result.length : 1;
                        } else {
                            var error = await response.json();
                            errors.push(file.name + ': ' + JSON.stringify(error));
                        }
                    } catch (error) {
                        console.error('Upload error for ' + file.name + ':', error);
                        errors.push(file.name + ': ' + error.message);
                    }
                }

                hideUploadModal();
                uploadBtn.disabled = false;
                progressDiv.style.display = 'none';

                if (errors.length > 0) {
                    alert('Some uploads failed:\n' + errors.join('\n'));
                }

                if (totalSheets > 0) {
                    if (typeof loadProjectData === 'function') loadProjectData();
                }

                form.reset();
            });
        }

        // Close modals on outside click (but not while in verify-asset mode)
        document.querySelectorAll('.modal').forEach(function(modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === this && state.currentMode !== 'verify-asset') {
                    this.style.display = 'none';
                }
            });
        });
    });

    // ==================== Export ====================

    async function exportProject() {
        try {
            var response = await fetch('/api/projects/' + PROJECT_ID + '/export/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({})
            });

            var result = await response.json();
            if (response.ok) {
                alert('Export complete! Files saved to: ' + result.exports.map(function(e) { return e.output_path; }).join(', '));
            } else {
                alert('Export error: ' + result.error);
            }
        } catch (error) {
            console.error('Export error:', error);
        }
    }

    function downloadReport() {
        window.open('/api/projects/' + PROJECT_ID + '/adjustment-report/?format=csv', '_blank');
    }

    // ==================== Import Batches ====================

    async function renderImportBatches() {
        var container = document.getElementById('import-batches');
        if (!container) return;

        try {
            var resp = await fetch('/api/projects/' + PROJECT_ID + '/import-batches/');
            if (!resp.ok) return;
            var allBatches = await resp.json();

            var batches = allBatches.filter(function(b) { return !b.filename.startsWith('links:'); });

            container.innerHTML = '';
            if (batches.length === 0) return;

            batches.forEach(function(batch) {
                var div = document.createElement('div');
                div.className = 'batch-item';

                var header = document.createElement('div');
                header.className = 'batch-header';

                var nameSpan = document.createElement('span');
                nameSpan.className = 'batch-name';
                nameSpan.textContent = batch.filename;
                nameSpan.title = batch.filename;

                var countSpan = document.createElement('span');
                countSpan.className = 'batch-count';
                countSpan.textContent = '' + batch.asset_count;

                var typeBtn = document.createElement('button');
                typeBtn.className = 'batch-delete-btn';
                typeBtn.textContent = '\u25CF';
                typeBtn.title = 'Change asset type for this batch';
                typeBtn.style.fontSize = '0.75rem';
                typeBtn.addEventListener('click', function() { showBatchTypeSelect(div, batch.id); });

                var delBtn = document.createElement('button');
                delBtn.className = 'batch-delete-btn';
                delBtn.textContent = '\u00D7';
                delBtn.title = 'Delete this batch and its assets';
                delBtn.addEventListener('click', function() { deleteImportBatch(batch.id, batch.filename); });

                var visCheckbox = document.createElement('input');
                visCheckbox.type = 'checkbox';
                visCheckbox.className = 'batch-visibility';
                visCheckbox.checked = true;
                visCheckbox.title = 'Toggle batch visibility';
                visCheckbox.style.marginRight = '0.3rem';
                visCheckbox.addEventListener('change', function() {
                    toggleBatchVisibility(batch.id, this.checked);
                });

                header.appendChild(visCheckbox);
                header.appendChild(nameSpan);
                header.appendChild(countSpan);
                header.appendChild(typeBtn);
                header.appendChild(delBtn);
                div.appendChild(header);
                container.appendChild(div);
            });
        } catch (err) {
            console.error('Error loading import batches:', err);
        }
    }

    async function renderLinkImportBatches() {
        var container = document.getElementById('link-import-batches');
        if (!container) return;

        try {
            var resp = await fetch('/api/projects/' + PROJECT_ID + '/import-batches/');
            if (!resp.ok) return;
            var allBatches = await resp.json();

            var batches = allBatches.filter(function(b) { return b.filename.startsWith('links:'); });

            container.innerHTML = '';
            if (batches.length === 0) return;

            batches.forEach(function(batch) {
                var div = document.createElement('div');
                div.className = 'batch-item';

                var header = document.createElement('div');
                header.className = 'batch-header';

                var nameSpan = document.createElement('span');
                nameSpan.className = 'batch-name';
                var displayName = batch.filename.replace(/^links:/, '');
                nameSpan.textContent = displayName;
                nameSpan.title = displayName;

                var countSpan = document.createElement('span');
                countSpan.className = 'batch-count';
                countSpan.textContent = '' + batch.asset_count;

                var delBtn = document.createElement('button');
                delBtn.className = 'batch-delete-btn';
                delBtn.textContent = '\u00D7';
                delBtn.title = 'Delete this batch and its links';
                delBtn.addEventListener('click', function() { deleteLinkImportBatch(batch.id, displayName); });

                var visCheckbox = document.createElement('input');
                visCheckbox.type = 'checkbox';
                visCheckbox.className = 'batch-visibility';
                visCheckbox.checked = true;
                visCheckbox.title = 'Toggle batch visibility';
                visCheckbox.style.marginRight = '0.3rem';
                visCheckbox.addEventListener('change', function() {
                    toggleLinkBatchVisibility(batch.id, this.checked);
                });

                header.appendChild(visCheckbox);
                header.appendChild(nameSpan);
                header.appendChild(countSpan);
                header.appendChild(delBtn);
                div.appendChild(header);
                container.appendChild(div);
            });
        } catch (err) {
            console.error('Error loading link import batches:', err);
        }
    }

    async function deleteLinkImportBatch(batchId, filename) {
        if (!confirm('Delete batch "' + filename + '" and all its links?')) return;

        try {
            var resp = await fetch('/api/import-batches/' + batchId + '/', {
                method: 'DELETE',
                headers: { 'X-CSRFToken': DW.getCSRFToken() }
            });

            if (resp.ok) {
                if (typeof loadProjectData === 'function') await loadProjectData();
            } else {
                alert('Failed to delete batch');
            }
        } catch (err) {
            console.error('Error deleting link batch:', err);
        }
    }

    function toggleLinkBatchVisibility(batchId, visible) {
        var canvas = state.canvas;
        if (!canvas) return;
        state.links.forEach(function(link) {
            if (link.import_batch === batchId) {
                var fabricObj = canvas.getObjects().find(function(o) { return o.linkId === link.id; });
                if (fabricObj) {
                    fabricObj.visible = visible;
                }
            }
        });
        canvas.requestRenderAll();
    }

    function toggleBatchVisibility(batchId, visible) {
        var canvas = state.canvas;
        if (!canvas) return;
        canvas.getObjects().forEach(function(obj) {
            if (obj.assetData && obj.assetData.import_batch === batchId) {
                obj.visible = visible;
            }
        });
        canvas.renderAll();
    }

    function showBatchTypeSelect(batchDiv, batchId) {
        var existing = batchDiv.querySelector('.batch-type-row');
        if (existing) { existing.remove(); return; }

        var row = document.createElement('div');
        row.className = 'batch-type-row';
        row.style.cssText = 'display:flex;gap:0.25rem;margin-top:0.3rem;align-items:center;';

        var sel = document.createElement('select');
        sel.style.cssText = 'flex:1;padding:0.2rem;border:1px solid var(--border-color,#ddd);border-radius:4px;font-size:0.8rem;background:var(--bg-input,#fff);color:var(--text-primary,#333);';

        var typeNames = {};
        state.assets.forEach(function(a) {
            if (a.asset_type_data && a.asset_type_data.name) typeNames[a.asset_type_data.name] = true;
        });
        ['TN Intersection', 'VSL', 'CCTV'].forEach(function(n) { typeNames[n] = true; });

        Object.keys(typeNames).sort().forEach(function(name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });

        var customOpt = document.createElement('option');
        customOpt.value = '__custom__';
        customOpt.textContent = '+ New type...';
        sel.appendChild(customOpt);

        var applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-success';
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = 'padding:0.2rem 0.5rem;font-size:0.8rem;';
        applyBtn.addEventListener('click', function() {
            var typeName = sel.value;
            if (typeName === '__custom__') {
                typeName = prompt('Enter new asset type name:');
                if (!typeName || !typeName.trim()) return;
                typeName = typeName.trim();
            }
            reassignBatchType(batchId, typeName);
        });

        row.appendChild(sel);
        row.appendChild(applyBtn);
        batchDiv.appendChild(row);
    }

    async function reassignBatchType(batchId, typeName) {
        try {
            var resp = await fetch('/api/import-batches/' + batchId + '/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ asset_type_name: typeName })
            });
            if (!resp.ok) {
                var data = await resp.json().catch(function() { return {}; });
                alert(data.error || 'Failed to reassign asset type');
                return;
            }
            await resp.json();
            var assetsResp = await fetch('/api/projects/' + PROJECT_ID + '/assets/');
            state.assets = await assetsResp.json();
            if (typeof renderAssetList === 'function') renderAssetList();
            if (typeof refreshAssets === 'function') refreshAssets();
            renderImportBatches();
        } catch (err) {
            console.error('Error reassigning batch type:', err);
            alert('Error reassigning asset type');
        }
    }

    async function deleteImportBatch(batchId, filename) {
        if (!confirm('Delete batch "' + filename + '" and all its assets?')) return;

        try {
            var resp = await fetch('/api/import-batches/' + batchId + '/', {
                method: 'DELETE',
                headers: { 'X-CSRFToken': DW.getCSRFToken() }
            });
            if (!resp.ok) {
                var data = await resp.json().catch(function() { return {}; });
                alert(data.error || 'Failed to delete batch');
                return;
            }
            var assetsResp = await fetch('/api/projects/' + PROJECT_ID + '/assets/');
            state.assets = await assetsResp.json();

            // Clear calibration if no assets remain
            if (state.assets.length === 0) {
                state.refAssetId = '';
                state.refPixelX = 0;
                state.refPixelY = 0;
                state.assetRotationDeg = 0;
                PROJECT_DATA.ref_asset_id = '';
                PROJECT_DATA.ref_pixel_x = 0;
                PROJECT_DATA.ref_pixel_y = 0;
                PROJECT_DATA.asset_rotation = 0;
                if (state.verifyRefMarker) {
                    state.canvas.remove(state.verifyRefMarker);
                    state.verifyRefMarker = null;
                }
            }

            if (typeof renderAssetList === 'function') renderAssetList();
            if (typeof refreshAssets === 'function') refreshAssets();
            renderImportBatches();
        } catch (err) {
            console.error('Error deleting batch:', err);
            alert('Error deleting batch');
        }
    }

    async function deleteAsset(assetId, assetLabel) {
        if (!confirm('Delete asset "' + assetLabel + '"?')) return false;

        try {
            var resp = await fetch('/api/assets/' + assetId + '/', {
                method: 'DELETE',
                headers: { 'X-CSRFToken': DW.getCSRFToken() }
            });
            if (!resp.ok) {
                DW.showToast('Failed to delete asset', 'error');
                return false;
            }
            var assetsResp = await fetch('/api/projects/' + PROJECT_ID + '/assets/');
            state.assets = await assetsResp.json();
            if (typeof renderAssetList === 'function') renderAssetList();
            if (typeof refreshAssets === 'function') refreshAssets();
            renderImportBatches();
            DW.showToast('Asset "' + assetLabel + '" deleted', 'success');
            return true;
        } catch (err) {
            console.error('Error deleting asset:', err);
            DW.showToast('Error deleting asset', 'error');
            return false;
        }
    }

    async function deleteLink(linkId, linkLabel) {
        if (!confirm('Delete link "' + linkLabel + '"?')) return false;

        try {
            var resp = await fetch('/api/links/' + linkId + '/', {
                method: 'DELETE',
                headers: { 'X-CSRFToken': DW.getCSRFToken() }
            });
            if (!resp.ok) {
                DW.showToast('Failed to delete link', 'error');
                return false;
            }
            var linksResp = await fetch('/api/projects/' + PROJECT_ID + '/links/');
            state.links = await linksResp.json();
            if (typeof renderLinkList === 'function') renderLinkList();
            if (typeof renderLinkGroupList === 'function') renderLinkGroupList();
            DW.showToast('Link "' + linkLabel + '" deleted', 'success');
            return true;
        } catch (err) {
            console.error('Error deleting link:', err);
            DW.showToast('Error deleting link', 'error');
            return false;
        }
    }

    // ==================== Public API ====================

    DW.imports = {
        showUploadModal: showUploadModal,
        hideUploadModal: hideUploadModal,
        showImportModal: showImportModal,
        hideImportModal: hideImportModal,
        importStepNext: importStepNext,
        toggleAssetTypeMode: toggleAssetTypeMode,
        importStepBack: importStepBack,
        importWithMapping: importWithMapping,
        showImportLinksModal: showImportLinksModal,
        hideImportLinksModal: hideImportLinksModal,
        importLinksStepNext: importLinksStepNext,
        importLinksStepBack: importLinksStepBack,
        importLinksWithMapping: importLinksWithMapping,
        exportProject: exportProject,
        downloadReport: downloadReport,
        renderImportBatches: renderImportBatches,
        renderLinkImportBatches: renderLinkImportBatches,
        deleteLinkImportBatch: deleteLinkImportBatch,
        toggleLinkBatchVisibility: toggleLinkBatchVisibility,
        toggleBatchVisibility: toggleBatchVisibility,
        showBatchTypeSelect: showBatchTypeSelect,
        reassignBatchType: reassignBatchType,
        deleteImportBatch: deleteImportBatch,
        deleteAsset: deleteAsset,
        deleteLink: deleteLink
    };

    // Backward compatibility
    window.showUploadModal = showUploadModal;
    window.hideUploadModal = hideUploadModal;
    window.showImportModal = showImportModal;
    window.hideImportModal = hideImportModal;
    window.importStepNext = importStepNext;
    window.toggleAssetTypeMode = toggleAssetTypeMode;
    window.importStepBack = importStepBack;
    window.importWithMapping = importWithMapping;
    window.showImportLinksModal = showImportLinksModal;
    window.hideImportLinksModal = hideImportLinksModal;
    window.importLinksStepNext = importLinksStepNext;
    window.importLinksStepBack = importLinksStepBack;
    window.importLinksWithMapping = importLinksWithMapping;
    window.exportProject = exportProject;
    window.downloadReport = downloadReport;
    window.renderImportBatches = renderImportBatches;
    window.renderLinkImportBatches = renderLinkImportBatches;
    window.deleteLinkImportBatch = deleteLinkImportBatch;
    window.toggleLinkBatchVisibility = toggleLinkBatchVisibility;
    window.toggleBatchVisibility = toggleBatchVisibility;
    window.showBatchTypeSelect = showBatchTypeSelect;
    window.reassignBatchType = reassignBatchType;
    window.deleteImportBatch = deleteImportBatch;
    window.deleteAsset = deleteAsset;
    window.deleteLink = deleteLink;

    console.log('DocuWeaver imports module loaded');
})();
