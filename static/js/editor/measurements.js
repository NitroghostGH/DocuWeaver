/**
 * DocuWeaver Canvas Editor - Measurements Module
 * 
 * Handles measurement tool UI, sets management, and config modal.
 * Note: The core MeasurementTool is in measurement_tool.js
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Measurement Calculations ====================
    
    function calcMeasureDistance(p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const pixelDist = Math.sqrt(dx * dx + dy * dy);
        const ppm = PROJECT_DATA.pixels_per_meter;
        if (PROJECT_DATA.scale_calibrated && ppm && isFinite(ppm) && ppm > 0) {
            return { pixels: pixelDist, meters: pixelDist / ppm, calibrated: true };
        }
        return { pixels: pixelDist, meters: null, calibrated: false };
    }
    
    function formatMeasureDistance(dist) {
        if (dist.calibrated) {
            if (dist.meters >= 1000) return `${(dist.meters / 1000).toFixed(2)} km`;
            if (dist.meters >= 1) return `${dist.meters.toFixed(2)} m`;
            return `${(dist.meters * 100).toFixed(1)} cm`;
        }
        return `${Math.round(dist.pixels)} px`;
    }
    
    // ==================== Measurement Tool UI ====================
    
    function bringMeasurementsToFront() {
        // Use rendering hierarchy instead of always bringing to front
        if (typeof applyRenderingHierarchy === 'function') {
            applyRenderingHierarchy();
        } else {
            // Fallback to old behavior if hierarchy system not available
            const canvas = state.canvas;
            const measurements = canvas.getObjects().filter(obj => 
                obj.isMeasurement || obj.isMeasurementGroup || obj.isSavedMeasurement
            );
            measurements.forEach(m => canvas.bringToFront(m));
        }
    }
    
    function removeMeasurePreview() {
        const canvas = state.canvas;
        if (state.measurePreviewLine) {
            canvas.remove(state.measurePreviewLine);
            state.measurePreviewLine = null;
        }
        if (state.measurePreviewLabel) {
            canvas.remove(state.measurePreviewLabel);
            state.measurePreviewLabel = null;
        }
    }
    
    function clearMeasurements() {
        const canvas = state.canvas;
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.clearCurrent();
        }
        state.measureOverlays.forEach(obj => canvas.remove(obj));
        state.measureOverlays = [];
        removeMeasurePreview();
        state.measurePoints = [];
        window.measurePoints = [];
        updateMeasurePanel();
        canvas.renderAll();
    }
    
    function toggleMeasureMode(mode) {
        // Clear existing measurement FIRST before switching modes
        clearMeasurements();
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.clearCurrent();
        }
        
        state.measureMode = mode;
        window.measureMode = mode;
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.startMeasurement(mode);
        }
    }
    
    function toggleMeasurePanel() {
        const section = document.getElementById('measure-section');
        const isVisible = section && section.style.display !== 'none';
        
        if (isVisible) {
            if (section) section.style.display = 'none';
            clearMeasurements();
            if (typeof MeasurementTool !== 'undefined') {
                MeasurementTool.clearCurrent();
            }
            if (typeof setMode === 'function') {
                setMode('pan');
            }
            return;
        }
        
        if (section) section.style.display = 'block';
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.startMeasurement(state.measureMode);
        }
        if (typeof setMode === 'function') {
            setMode('measure');
        }
    }
    
    function handleMeasureClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.addPoint(pointer.x, pointer.y);
        }
    }
    
    function handleMeasureMove(opt) {
        if (state.measurePoints.length === 0) return;
        if (state.measureMode === 'single' && state.measurePoints.length >= 2) return;

        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        const lastPt = state.measurePoints[state.measurePoints.length - 1];

        // Update or create preview line
        if (!state.measurePreviewLine) {
            state.measurePreviewLine = new fabric.Line(
                [lastPt.x, lastPt.y, pointer.x, pointer.y],
                { 
                    stroke: '#00bcd4', 
                    strokeWidth: 1, 
                    strokeUniform: true,
                    strokeDashArray: [4, 4], 
                    opacity: 0.6, 
                    selectable: false, 
                    evented: false,
                    isMeasurement: true
                }
            );
            canvas.add(state.measurePreviewLine);
        } else {
            state.measurePreviewLine.set({ 
                x1: lastPt.x, 
                y1: lastPt.y, 
                x2: pointer.x, 
                y2: pointer.y 
            });
        }
        canvas.bringToFront(state.measurePreviewLine);

        // Update or create preview label
        const dist = calcMeasureDistance(lastPt, pointer);
        const label = formatMeasureDistance(dist);
        const midX = (lastPt.x + pointer.x) / 2;
        const midY = (lastPt.y + pointer.y) / 2;
        
        if (!state.measurePreviewLabel) {
            state.measurePreviewLabel = new fabric.Text(label, {
                left: midX, 
                top: midY - 18, 
                fontSize: 11, 
                fill: '#ffffff',
                backgroundColor: 'rgba(0, 188, 212, 0.5)', 
                fontFamily: 'monospace',
                padding: 3, 
                selectable: false, 
                evented: false,
                isMeasurement: true
            });
            canvas.add(state.measurePreviewLabel);
        } else {
            state.measurePreviewLabel.set({ text: label, left: midX, top: midY - 18 });
        }
        canvas.bringToFront(state.measurePreviewLabel);
        canvas.requestRenderAll();
    }
    
    function updateMeasurePanel() {
        const segmentList = document.getElementById('measure-segments');
        const totalEl = document.getElementById('measure-total');
        const straightEl = document.getElementById('measure-straight');
        const straightRow = document.getElementById('measure-straight-row');
        const warningEl = document.getElementById('measure-scale-warning');

        if (!segmentList) return;

        if (warningEl) {
            warningEl.style.display = PROJECT_DATA.scale_calibrated ? 'none' : 'block';
        }

        segmentList.innerHTML = '';

        if (state.measurePoints.length < 2) {
            totalEl.textContent = '--';
            straightEl.textContent = '--';
            straightRow.style.display = 'none';
            return;
        }

        let totalPixels = 0;
        let totalMeters = 0;
        let allCalibrated = true;

        for (let i = 1; i < state.measurePoints.length; i++) {
            const dist = calcMeasureDistance(state.measurePoints[i - 1], state.measurePoints[i]);
            totalPixels += dist.pixels;
            if (dist.calibrated) { 
                totalMeters += dist.meters; 
            } else { 
                allCalibrated = false; 
            }

            const li = document.createElement('div');
            li.style.cssText = 'padding: 0.2rem 0; font-size: 0.8rem; border-bottom: 1px solid var(--border-light, #e0e0e0); display: flex; justify-content: space-between;';
            li.innerHTML = `<span>Seg ${i}</span><span>${formatMeasureDistance(dist)}</span>`;
            segmentList.appendChild(li);
        }

        const totalDist = allCalibrated
            ? { pixels: totalPixels, meters: totalMeters, calibrated: true }
            : { pixels: totalPixels, meters: null, calibrated: false };
        totalEl.textContent = formatMeasureDistance(totalDist);

        // Straight-line distance
        if (state.measureMode === 'chain' && state.measurePoints.length >= 3) {
            straightRow.style.display = 'flex';
            const straightDist = calcMeasureDistance(
                state.measurePoints[0], 
                state.measurePoints[state.measurePoints.length - 1]
            );
            straightEl.textContent = formatMeasureDistance(straightDist);
        } else {
            straightRow.style.display = 'none';
        }
    }
    
    function clearMeasurementOverlays() {
        const canvas = state.canvas;
        const overlays = canvas.getObjects().filter(obj => obj.isMeasurementOverlay);
        overlays.forEach(obj => canvas.remove(obj));
        canvas.renderAll();
    }
    
    // ==================== Measurement Sets ====================
    
    async function loadMeasurementSets() {
        try {
            const resp = await fetch(`/api/projects/${PROJECT_ID}/measurement-sets/`);
            if (resp.ok) {
                state.measurementSets = await resp.json();
                window.measurementSets = state.measurementSets;
                renderMeasurementSetsUI();
            }
        } catch (err) {
            console.error('Error loading measurement sets:', err);
        }
    }
    
    function renderMeasurementSetsUI() {
        const container = document.getElementById('measurement-sets-list');
        if (!container) return;

        container.innerHTML = '';

        if (state.measurementSets.length === 0) {
            container.innerHTML = '<p class="text-muted small">No saved measurements</p>';
            return;
        }

        state.measurementSets.forEach(ms => {
            const div = document.createElement('div');
            div.className = 'measurement-set-item d-flex align-items-center py-1 px-2 border-bottom';
            div.dataset.measurementId = ms.id;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = ms.visible;
            checkbox.className = 'ms-visibility me-2';
            checkbox.title = 'Toggle measurement visibility';
            checkbox.addEventListener('change', () => toggleMeasurementSetVisibility(ms.id, checkbox.checked));

            const colorDot = document.createElement('span');
            colorDot.style.cssText = `
                display: inline-block;
                width: 12px;
                height: 12px;
                border-radius: 2px;
                background-color: ${ms.color || '#00bcd4'};
                margin-right: 8px;
                flex-shrink: 0;
            `;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'text-truncate flex-grow-1';
            nameSpan.textContent = ms.name;

            const typeBadge = document.createElement('span');
            typeBadge.className = 'badge ms-1';
            typeBadge.className += ms.measurement_type === 'chain' ? ' bg-warning' : ' bg-info';
            typeBadge.textContent = ms.measurement_type;
            typeBadge.style.fontSize = '0.65em';

            const distSpan = document.createElement('span');
            distSpan.className = 'small text-muted ms-1';
            if (ms.total_distance_meters) {
                distSpan.textContent = `${ms.total_distance_meters.toFixed(2)}m`;
            } else if (ms.total_distance_pixels) {
                distSpan.textContent = `${ms.total_distance_pixels.toFixed(0)}px`;
            }

            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn btn-sm btn-outline-primary ms-1';
            viewBtn.style.padding = '0 4px';
            viewBtn.style.fontSize = '0.7em';
            viewBtn.textContent = '👁';
            viewBtn.title = 'Show on canvas';
            viewBtn.addEventListener('click', () => showMeasurementSetOnCanvas(ms));

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-sm btn-outline-danger ms-1';
            delBtn.style.padding = '0 4px';
            delBtn.style.fontSize = '0.7em';
            delBtn.textContent = '×';
            delBtn.title = 'Delete measurement';
            delBtn.addEventListener('click', () => deleteMeasurementSet(ms.id, ms.name));

            div.appendChild(checkbox);
            div.appendChild(colorDot);
            div.appendChild(nameSpan);
            div.appendChild(typeBadge);
            div.appendChild(distSpan);
            div.appendChild(viewBtn);
            div.appendChild(delBtn);

            container.appendChild(div);
        });
    }
    
    async function toggleMeasurementSetVisibility(msId, visible) {
        if (typeof MeasurementTool !== 'undefined') {
            const success = await MeasurementTool.toggleVisibility(msId, visible);
            if (success) {
                // Reload measurement sets to sync state
                await loadMeasurementSets();
            }
            return success;
        }
    }
    
    function showMeasurementSetOnCanvas(ms) {
        if (!ms.points || ms.points.length === 0) return;

        clearMeasurementOverlays();

        const canvas = state.canvas;
        const color = ms.color || '#00bcd4';
        const points = ms.points;

        if (points.length === 1) {
            const marker = new fabric.Circle({
                left: points[0].x,
                top: points[0].y,
                radius: 6,
                fill: color,
                stroke: '#fff',
                strokeWidth: 2,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: false,
                isMeasurementOverlay: true
            });
            canvas.add(marker);
        } else {
            for (let i = 0; i < points.length - 1; i++) {
                const line = new fabric.Line(
                    [points[i].x, points[i].y, points[i + 1].x, points[i + 1].y],
                    {
                        stroke: color,
                        strokeWidth: 2,
                        selectable: false,
                        evented: false,
                        isMeasurementOverlay: true
                    }
                );
                canvas.add(line);
            }

            points.forEach((pt, idx) => {
                const marker = new fabric.Circle({
                    left: pt.x,
                    top: pt.y,
                    radius: idx === 0 || idx === points.length - 1 ? 6 : 4,
                    fill: idx === 0 ? '#00ff00' : (idx === points.length - 1 ? '#ff0000' : color),
                    stroke: '#fff',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center',
                    selectable: false,
                    evented: false,
                    isMeasurementOverlay: true
                });
                canvas.add(marker);
            });

            if (ms.total_distance_meters || ms.total_distance_pixels) {
                const lastPt = points[points.length - 1];
                const prevPt = points[points.length - 2];
                const midX = (lastPt.x + prevPt.x) / 2;
                const midY = (lastPt.y + prevPt.y) / 2;
                const distText = ms.total_distance_meters
                    ? `${ms.total_distance_meters.toFixed(2)}m`
                    : `${ms.total_distance_pixels.toFixed(0)}px`;

                const label = new fabric.Text(distText, {
                    left: midX + 10,
                    top: midY - 10,
                    fontSize: 12,
                    fill: color,
                    backgroundColor: 'rgba(255,255,255,0.8)',
                    selectable: false,
                    evented: false,
                    isMeasurementOverlay: true
                });
                canvas.add(label);
            }
        }

        canvas.renderAll();
    }
    
    function renderSavedMeasurementsOnCanvas() {
        const canvas = state.canvas;
        
        const savedOverlays = canvas.getObjects().filter(obj => obj.isSavedMeasurement);
        savedOverlays.forEach(obj => canvas.remove(obj));

        state.measurementSets.filter(ms => ms.visible).forEach(ms => {
            if (!ms.points || ms.points.length === 0) return;

            const color = ms.color || '#00bcd4';
            const points = ms.points;

            if (points.length >= 2) {
                for (let i = 0; i < points.length - 1; i++) {
                    const line = new fabric.Line(
                        [points[i].x, points[i].y, points[i + 1].x, points[i + 1].y],
                        {
                            stroke: color,
                            strokeWidth: 2,
                            strokeDashArray: [5, 5],
                            selectable: false,
                            evented: false,
                            isSavedMeasurement: true,
                            measurementSetId: ms.id
                        }
                    );
                    canvas.add(line);
                }
            }

            points.forEach((pt, idx) => {
                const marker = new fabric.Circle({
                    left: pt.x,
                    top: pt.y,
                    radius: 4,
                    fill: color,
                    stroke: '#fff',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center',
                    selectable: false,
                    evented: false,
                    isSavedMeasurement: true,
                    measurementSetId: ms.id
                });
                canvas.add(marker);
            });
        });

        bringMeasurementsToFront();
        canvas.renderAll();
    }
    
    function saveMeasurementPrompt() {
        showSaveMeasurementModal();
    }
    
    function showSaveMeasurementModal() {
        const modal = document.getElementById('saveMeasurementModal');
        const folderSelect = document.getElementById('measurement-folder');
        const nameInput = document.getElementById('measurement-name');
        
        if (!modal) return;
        
        folderSelect.innerHTML = '<option value="">Ungrouped</option>';
        
        const measurementGroups = PROJECT_DATA.measurementGroups || [];
        measurementGroups.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = g.name;
            folderSelect.appendChild(opt);
        });
        
        nameInput.value = '';
        modal.style.display = 'flex';
        nameInput.focus();
    }
    
    function hideSaveMeasurementModal() {
        const modal = document.getElementById('saveMeasurementModal');
        if (modal) modal.style.display = 'none';
    }
    
    async function saveCurrentMeasurement() {
        return saveMeasurementPrompt();
    }
    
    async function deleteMeasurementSet(msId, name) {
        if (typeof MeasurementTool !== 'undefined') {
            return await MeasurementTool.delete(msId, name);
        }
    }
    
    // ==================== Measurement Config Modal ====================
    
    function showMeasurementConfigModal() {
        const modal = document.getElementById('measurementConfigModal');
        if (!modal) return;
        
        if (typeof MeasurementTool === 'undefined') return;
        
        const config = MeasurementTool.getConfig();
        
        // Populate display settings
        document.getElementById('config-show-distance').checked = config.showDistance !== false;
        document.getElementById('config-show-angle').checked = config.showAngle !== false;
        document.getElementById('config-label-scale').value = config.labelScale || 1;
        document.getElementById('config-scale-value').textContent = (config.labelScale || 1).toFixed(1);
        
        // Populate line style settings
        document.getElementById('config-line-style').value = config.lineStyle || 'dashed';
        document.getElementById('config-line-thickness').value = config.lineStrokeWidth || 1.5;
        document.getElementById('config-thickness-value').textContent = config.lineStrokeWidth || 1.5;
        document.getElementById('config-line-color').value = config.lineColor || '#00bcd4';
        document.getElementById('config-line-color-hex').value = config.lineColor || '#00bcd4';
        
        if (document.getElementById('config-marker-size')) {
            document.getElementById('config-marker-size').value = config.markerSize || 4;
            document.getElementById('config-marker-value').textContent = config.markerSize || 4;
        }
        
        refreshConfigTypesList();
        switchConfigTab('style');
        
        modal.style.display = 'flex';
    }
    
    function hideMeasurementConfigModal() {
        const modal = document.getElementById('measurementConfigModal');
        if (modal) modal.style.display = 'none';
    }
    
    function switchConfigTab(tabName) {
        document.querySelectorAll('.config-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        
        document.querySelectorAll('.config-tab-content').forEach(panel => {
            const isActive = panel.id === `config-tab-${tabName}`;
            panel.style.display = isActive ? 'block' : 'none';
        });
    }
    
    // Alias for HTML compatibility
    function switchMeasureConfigTab(tabName) {
        switchConfigTab(tabName);
    }
    
    function saveMeasurementConfig() {
        if (typeof MeasurementTool === 'undefined') return;
        
        const lineStyle = document.getElementById('config-line-style').value || 'dashed';
        const lineThickness = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
        const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
        
        const config = {
            showDistance: document.getElementById('config-show-distance').checked,
            showAngle: document.getElementById('config-show-angle').checked,
            labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
            lineStyle: lineStyle,
            lineStrokeWidth: lineThickness,
            lineColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerSize: markerSize,
            previewLineColor: document.getElementById('config-line-color').value || '#00bcd4'
        };
        
        config.lineDashArray = MeasurementTool.getLineDashArray(config.lineStyle, config.lineStrokeWidth);
        
        MeasurementTool.updateConfig(config);
        hideMeasurementConfigModal();
        updateConfigPreviewBar();

        console.log('Measurement config saved:', config);
    }
    
    function onMeasureConfigTypeChange(value) {
        if (typeof MeasurementTool === 'undefined') return;
        MeasurementTool.setConfigType(value);
        updateConfigPreviewBar();
    }

    function populateConfigTypeSelect() {
        const select = document.getElementById('measure-config-type');
        if (!select || typeof MeasurementTool === 'undefined') return;

        const configTypes = MeasurementTool.getConfigTypes();
        const currentType = MeasurementTool.getCurrentConfigType();
        select.innerHTML = '';

        Object.entries(configTypes).forEach(([key, ct]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = ct.name || key;
            if (key === currentType) option.selected = true;
            select.appendChild(option);
        });

        updateConfigPreviewBar();
    }

    function updateConfigPreviewBar() {
        const preview = document.getElementById('measure-config-preview');
        if (!preview || typeof MeasurementTool === 'undefined') return;

        const config = MeasurementTool.getConfig();
        const lineColor = config.lineColor || '#00bcd4';
        const lineStyle = config.lineStyle || 'dashed';

        if (lineStyle === 'dashed') {
            preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 10px)`;
        } else if (lineStyle === 'dotted') {
            preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 2px, transparent 2px, transparent 5px)`;
        } else {
            preview.style.background = lineColor;
        }
    }

    function refreshConfigTypesList() {
        const container = document.getElementById('config-presets-list');
        if (!container || typeof MeasurementTool === 'undefined') return;
        
        const configTypes = MeasurementTool.getConfigTypes();
        const currentType = MeasurementTool.getCurrentConfigType();
        container.innerHTML = '';
        
        Object.entries(configTypes).forEach(([key, ct]) => {
            const item = document.createElement('div');
            item.className = 'config-type-item';
            if (key === currentType) {
                item.classList.add('active');
            }
            
            const cfg = ct.config || {};
            item.innerHTML = `
                <span class="config-type-name">${ct.name || key}</span>
                <div class="config-type-actions">
                    <button type="button" class="btn-apply" onclick="applyConfigType('${key}')">Apply</button>
                    <button type="button" class="btn-edit" onclick="editConfigType('${key}')">Edit</button>
                    ${key !== 'default' ? `<button type="button" class="btn-delete-config" onclick="deleteConfigTypeHandler('${key}')">×</button>` : ''}
                </div>
            `;
            
            const preview = document.createElement('span');
            preview.className = 'config-type-preview';
            const lineColor = cfg.lineColor || '#00bcd4';
            const lineStyle = cfg.lineStyle || 'dashed';
            
            // Set background based on line style
            if (lineStyle === 'solid') {
                preview.style.backgroundColor = lineColor;
            } else if (lineStyle === 'dashed') {
                preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 10px)`;
            } else if (lineStyle === 'dotted') {
                preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 2px, transparent 2px, transparent 5px)`;
            } else if (lineStyle === 'dashdot') {
                preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 7px, ${lineColor} 7px, ${lineColor} 9px, transparent 9px, transparent 16px)`;
            } else {
                preview.style.backgroundColor = lineColor;
            }
            
            item.querySelector('.config-type-name').prepend(preview);
            
            container.appendChild(item);
        });
    }
    
    function applyConfigType(name) {
        if (typeof MeasurementTool === 'undefined') return;
        
        MeasurementTool.setConfigType(name);
        
        const config = MeasurementTool.getConfig();
        document.getElementById('config-show-distance').checked = config.showDistance !== false;
        document.getElementById('config-show-angle').checked = config.showAngle !== false;
        document.getElementById('config-label-scale').value = config.labelScale || 1;
        document.getElementById('config-scale-value').textContent = (config.labelScale || 1).toFixed(1);
        document.getElementById('config-line-style').value = config.lineStyle || 'dashed';
        document.getElementById('config-line-thickness').value = config.lineStrokeWidth || 1.5;
        document.getElementById('config-thickness-value').textContent = config.lineStrokeWidth || 1.5;
        document.getElementById('config-line-color').value = config.lineColor || '#00bcd4';
        document.getElementById('config-line-color-hex').value = config.lineColor || '#00bcd4';
        if (document.getElementById('config-marker-size')) {
            document.getElementById('config-marker-size').value = config.markerSize || 4;
            document.getElementById('config-marker-value').textContent = config.markerSize || 4;
        }
        
        refreshConfigTypesList();
        populateConfigTypeSelect();
        console.log('Applied config type:', name);
    }
    
    function addNewConfigType() {
        if (typeof MeasurementTool === 'undefined') return;
        
        const nameInput = document.getElementById('config-new-preset-name');
        const name = nameInput ? nameInput.value.trim() : prompt('Enter name for new measurement type:');
        if (!name) return;
        
        const key = name.toLowerCase().replace(/\s+/g, '_');
        
        const lineStyle = document.getElementById('config-line-style').value || 'dashed';
        const lineStrokeWidth = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
        const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
        
        const settings = {
            showDistance: document.getElementById('config-show-distance').checked,
            showAngle: document.getElementById('config-show-angle').checked,
            labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
            lineStyle: lineStyle,
            lineStrokeWidth: lineStrokeWidth,
            lineColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerSize: markerSize,
            previewLineColor: document.getElementById('config-line-color').value || '#00bcd4',
            lineDashArray: MeasurementTool.getLineDashArray(lineStyle, lineStrokeWidth)
        };
        
        const existingTypes = MeasurementTool.getConfigTypes();
        if (existingTypes[key]) {
            alert('A config type with that name already exists.');
            return;
        }
        
        MeasurementTool.saveConfigType(key, name, settings);
        refreshConfigTypesList();
        if (nameInput) nameInput.value = '';
        console.log('Added new config type:', key, name);
    }
    
    function editConfigType(key) {
        applyConfigType(key);
        switchConfigTab('style');
        window._editingConfigType = key;
        
        const configTypes = typeof MeasurementTool !== 'undefined' ? MeasurementTool.getConfigTypes() : {};
        const displayName = configTypes[key]?.name || key;
        
        const saveBtn = document.querySelector('#measurementConfigModal .btn-save');
        if (saveBtn) {
            saveBtn.textContent = `Update "${displayName}"`;
            saveBtn.onclick = function() {
                saveAndUpdateConfigType();
            };
        }
    }
    
    function saveAndUpdateConfigType() {
        if (typeof MeasurementTool === 'undefined') return;
        
        const key = window._editingConfigType;
        if (key) {
            const configTypes = MeasurementTool.getConfigTypes();
            const displayName = configTypes[key]?.name || key;
            
            const lineStyle = document.getElementById('config-line-style').value || 'dashed';
            const lineStrokeWidth = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
            const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
            
            const settings = {
                showDistance: document.getElementById('config-show-distance').checked,
                showAngle: document.getElementById('config-show-angle').checked,
                labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
                lineStyle: lineStyle,
                lineStrokeWidth: lineStrokeWidth,
                lineColor: document.getElementById('config-line-color').value || '#00bcd4',
                markerColor: document.getElementById('config-line-color').value || '#00bcd4',
                markerSize: markerSize,
                previewLineColor: document.getElementById('config-line-color').value || '#00bcd4',
                lineDashArray: MeasurementTool.getLineDashArray(lineStyle, lineStrokeWidth)
            };
            
            MeasurementTool.saveConfigType(key, displayName, settings);
            refreshConfigTypesList();
            console.log('Updated config type:', key);
        }
        
        window._editingConfigType = null;
        const saveBtn = document.querySelector('#measurementConfigModal .btn-save');
        if (saveBtn) {
            saveBtn.textContent = 'Save Settings';
            saveBtn.onclick = saveMeasurementConfig;
        }
        
        saveMeasurementConfig();
    }
    
    function deleteConfigTypeHandler(key) {
        if (typeof MeasurementTool === 'undefined') return;
        
        const configTypes = MeasurementTool.getConfigTypes();
        const displayName = configTypes[key]?.name || key;
        
        if (!confirm(`Delete measurement type "${displayName}"?`)) return;
        
        MeasurementTool.deleteConfigType(key);
        refreshConfigTypesList();
        console.log('Deleted config type:', key);
    }
    
    // ==================== Public API ====================
    
    DW.measurements = {
        calcMeasureDistance,
        formatMeasureDistance,
        bringMeasurementsToFront,
        removeMeasurePreview,
        clearMeasurements,
        toggleMeasureMode,
        toggleMeasurePanel,
        handleMeasureClick,
        handleMeasureMove,
        updateMeasurePanel,
        clearMeasurementOverlays,
        loadMeasurementSets,
        renderMeasurementSetsUI,
        toggleMeasurementSetVisibility,
        showMeasurementSetOnCanvas,
        renderSavedMeasurementsOnCanvas,
        saveMeasurementPrompt,
        showSaveMeasurementModal,
        hideSaveMeasurementModal,
        saveCurrentMeasurement,
        deleteMeasurementSet,
        showMeasurementConfigModal,
        hideMeasurementConfigModal,
        switchConfigTab,
        switchMeasureConfigTab,
        saveMeasurementConfig,
        refreshConfigTypesList,
        applyConfigType,
        addNewConfigType,
        editConfigType,
        saveAndUpdateConfigType,
        deleteConfigTypeHandler,
        onMeasureConfigTypeChange,
        populateConfigTypeSelect,
        updateConfigPreviewBar
    };
    
    // Expose globally for backward compatibility
    window.calcMeasureDistance = calcMeasureDistance;
    window.formatMeasureDistance = formatMeasureDistance;
    window.bringMeasurementsToFront = bringMeasurementsToFront;
    window.removeMeasurePreview = removeMeasurePreview;
    window.clearMeasurements = clearMeasurements;
    window.toggleMeasureMode = toggleMeasureMode;
    window.toggleMeasurePanel = toggleMeasurePanel;
    window.handleMeasureClick = handleMeasureClick;
    window.handleMeasureMove = handleMeasureMove;
    window.updateMeasurePanel = updateMeasurePanel;
    window.clearMeasurementOverlays = clearMeasurementOverlays;
    window.loadMeasurementSets = loadMeasurementSets;
    window.renderMeasurementSetsUI = renderMeasurementSetsUI;
    window.toggleMeasurementSetVisibility = toggleMeasurementSetVisibility;
    window.showMeasurementSetOnCanvas = showMeasurementSetOnCanvas;
    window.renderSavedMeasurementsOnCanvas = renderSavedMeasurementsOnCanvas;
    window.saveMeasurementPrompt = saveMeasurementPrompt;
    window.showSaveMeasurementModal = showSaveMeasurementModal;
    window.hideSaveMeasurementModal = hideSaveMeasurementModal;
    window.saveCurrentMeasurement = saveCurrentMeasurement;
    window.deleteMeasurementSet = deleteMeasurementSet;
    window.showMeasurementConfigModal = showMeasurementConfigModal;
    window.hideMeasurementConfigModal = hideMeasurementConfigModal;
    window.switchConfigTab = switchConfigTab;
    window.switchMeasureConfigTab = switchMeasureConfigTab;
    window.saveMeasurementConfig = saveMeasurementConfig;
    window.refreshConfigTypesList = refreshConfigTypesList;
    window.applyConfigType = applyConfigType;
    window.addNewConfigType = addNewConfigType;
    window.editConfigType = editConfigType;
    window.saveAndUpdateConfigType = saveAndUpdateConfigType;
    window.deleteConfigTypeHandler = deleteConfigTypeHandler;
    window.onMeasureConfigTypeChange = onMeasureConfigTypeChange;
    window.populateConfigTypeSelect = populateConfigTypeSelect;
    window.updateConfigPreviewBar = updateConfigPreviewBar;

    console.log('DocuWeaver measurements module loaded');
})();
