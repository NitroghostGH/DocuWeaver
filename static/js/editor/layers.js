/**
 * DocuWeaver Canvas Editor - Layers Module
 *
 * Handles layer groups and folder management: creating, renaming, deleting,
 * moving, joining/unjoining groups; rendering group lists in the sidebar;
 * drag-and-drop for items and folders; unified flat/folder views.
 *
 * Depends on: namespace.js
 *
 * Cross-module calls (guarded with typeof checks):
 *   - loadProjectData()        (main.js)
 *   - selectSheet()            (sheets.js)
 *   - toggleSheetVisibility()  (sheets.js)
 *   - clearAssetsFromCanvas()  (assets.js)
 *   - clearLinksFromCanvas()   (links.js)
 *   - renderAssetsOnCanvas()   (assets.js)
 *   - renderLinksOnCanvas()    (links.js)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // ==================== Private Module State ====================

    /** Whether the unified view shows folder hierarchy (true) or flat list (false) */
    let unifiedShowFolders = false;

    /** Currently dragged folder for folder-to-folder nesting */
    let draggedFolder = null;

    // ==================== Create Group Modal ====================

    function showCreateGroupModal(groupType) {
        const modal = document.getElementById('createGroupModal');
        const typeInput = document.getElementById('group-type');
        const parentSelect = document.getElementById('group-parent');
        const nameInput = document.getElementById('group-name');

        if (!modal) return;

        typeInput.value = groupType;
        nameInput.value = '';

        // Populate parent options based on group type
        let groups;
        if (groupType === 'asset') {
            groups = state.assetGroups;
        } else if (groupType === 'sheet') {
            groups = state.sheetGroups;
        } else if (groupType === 'measurement') {
            groups = state.measurementGroups;
        } else {
            groups = state.linkGroups;
        }
        parentSelect.innerHTML = '<option value="">None (Root level)</option>';
        groups.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = g.name;
            parentSelect.appendChild(opt);
        });

        modal.style.display = 'flex';
    }

    function hideCreateGroupModal() {
        const modal = document.getElementById('createGroupModal');
        if (modal) modal.style.display = 'none';
    }

    async function createLayerGroup(e) {
        e.preventDefault();

        const groupType = document.getElementById('group-type').value;
        const name = document.getElementById('group-name').value;
        const parentId = document.getElementById('group-parent').value;
        const scope = document.getElementById('group-scope').value || 'local';

        try {
            const resp = await fetch(`/api/projects/${PROJECT_ID}/layer-groups/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    name: name,
                    group_type: groupType,
                    scope: scope,
                    parent_group: parentId || null
                })
            });

            if (resp.ok) {
                hideCreateGroupModal();
                await loadLayerGroups();
            } else {
                const data = await resp.json();
                alert(data.error || 'Failed to create group');
            }
        } catch (err) {
            console.error('Error creating group:', err);
            alert('Error creating group');
        }
    }

    // Set up form handler when DOM is ready
    document.addEventListener('DOMContentLoaded', function() {
        const form = document.getElementById('createGroupForm');
        if (form) {
            form.addEventListener('submit', createLayerGroup);
        }
    });

    // ==================== Load & Render Groups ====================

    async function loadLayerGroups() {
        try {
            const [assetResp, linkResp, sheetResp, measurementResp] = await Promise.all([
                fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=asset`),
                fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=link`),
                fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=sheet`),
                fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=measurement`)
            ]);

            if (assetResp.ok) {
                state.assetGroups = await assetResp.json();
            }
            if (linkResp.ok) {
                state.linkGroups = await linkResp.json();
            }
            if (sheetResp.ok) {
                state.sheetGroups = await sheetResp.json();
            }
            if (measurementResp.ok) {
                state.measurementGroups = await measurementResp.json();
            }

            // Initialize visibility from loaded data
            [...state.assetGroups, ...state.linkGroups, ...state.sheetGroups, ...state.measurementGroups].forEach(g => {
                state.groupVisibility[g.id] = g.visible;
            });

            renderLayerGroupsUI();
        } catch (err) {
            console.error('Error loading layer groups:', err);
        }
    }

    function renderLayerGroupsUI() {
        renderAssetGroupList();
        renderLinkGroupList();
        renderSheetGroupList();
        renderMeasurementGroupList();
        renderUnifiedList();
    }

    // ==================== Hierarchy Utilities ====================

    function isDescendantOf(potentialDescendant, ancestorGroup) {
        if (!ancestorGroup.child_groups) return false;

        for (const child of ancestorGroup.child_groups) {
            if (child.id === potentialDescendant.id) return true;
            if (isDescendantOf(potentialDescendant, child)) return true;
        }
        return false;
    }

    function getAllGlobalGroups() {
        const allGroups = [...state.assetGroups, ...state.linkGroups, ...state.sheetGroups, ...state.measurementGroups];
        const globalGroups = allGroups.filter(g => g.scope === 'global' && !g.parent_group);

        const seen = new Set();
        return globalGroups.filter(g => {
            if (seen.has(g.id)) return false;
            seen.add(g.id);
            return true;
        });
    }

    function flattenGroupHierarchy(groups, depth) {
        if (depth === undefined) depth = 0;
        const result = [];
        groups.forEach(group => {
            result.push({ group: group, depth: depth });
            if (group.child_groups && group.child_groups.length > 0) {
                result.push.apply(result, flattenGroupHierarchy(group.child_groups, depth + 1));
            }
        });
        return result;
    }

    function getGroupItemCountForType(group, type, includeNested) {
        if (includeNested === undefined) includeNested = true;
        var count = 0;

        if (type === 'asset') {
            count = state.assets.filter(a => a.layer_group === group.id).length;
        } else if (type === 'sheet') {
            count = state.sheets.filter(s => s.layer_group === group.id).length;
        } else if (type === 'measurement') {
            const savedMeasurements = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : [];
            count = savedMeasurements.filter(m => m.layer_group === group.id).length;
        } else if (type === 'link') {
            count = state.links.filter(l => l.layer_group === group.id).length;
        }

        if (includeNested && group.child_groups && group.child_groups.length > 0) {
            group.child_groups.forEach(child => {
                count += getGroupItemCountForType(child, type, true);
            });
        }

        return count;
    }

    // ==================== Unified View ====================

    function toggleUnifiedFolderView(showFolders) {
        unifiedShowFolders = showFolders;
        renderUnifiedList();
    }

    function renderUnifiedList() {
        const container = document.getElementById('unified-items-list');
        if (!container) return;

        container.innerHTML = '';

        const savedMeasurements = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : [];

        if (!window.unifiedSectionCollapsed) {
            window.unifiedSectionCollapsed = {};
        }
        if (!window.unifiedFolderCollapsed) {
            window.unifiedFolderCollapsed = {};
        }

        if (unifiedShowFolders) {
            renderUnifiedFolderView(container, savedMeasurements);
        } else {
            renderUnifiedFlatView(container, savedMeasurements);
        }
    }

    function renderUnifiedFlatView(container, savedMeasurements) {
        const sections = [
            { type: 'sheet', items: state.sheets, icon: '\u{1F4C4}', label: 'Sheets' },
            { type: 'asset', items: state.assets, icon: '\u{1F4CD}', label: 'Assets' },
            { type: 'link', items: state.links, icon: '\u{1F517}', label: 'Links' },
            { type: 'measurement', items: savedMeasurements, icon: '\u{1F4D0}', label: 'Measurements' }
        ];

        sections.forEach(section => {
            if (section.items.length === 0) return;

            const sectionWrapper = document.createElement('div');
            sectionWrapper.className = 'unified-section';

            const sectionHeader = document.createElement('div');
            sectionHeader.className = 'unified-section-header';
            sectionHeader.style.cssText = 'font-size:0.75rem;font-weight:600;color:var(--text-muted);padding:4px 8px;background:var(--bg-secondary);border-radius:4px;margin:4px 0 2px 0;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;';

            const isCollapsed = window.unifiedSectionCollapsed[section.type];

            const chevron = document.createElement('span');
            chevron.textContent = isCollapsed ? '\u25B6' : '\u25BC';
            chevron.style.cssText = 'font-size:0.7rem;width:12px;';

            const labelSpan = document.createElement('span');
            labelSpan.innerHTML = '<span>' + section.icon + '</span> ' + section.label + ' (' + section.items.length + ')';
            labelSpan.style.flex = '1';

            sectionHeader.appendChild(chevron);
            sectionHeader.appendChild(labelSpan);

            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'unified-section-items';
            if (isCollapsed) {
                itemsContainer.style.display = 'none';
            }

            sectionHeader.addEventListener('click', function() {
                const nowCollapsed = !window.unifiedSectionCollapsed[section.type];
                window.unifiedSectionCollapsed[section.type] = nowCollapsed;
                chevron.textContent = nowCollapsed ? '\u25B6' : '\u25BC';
                itemsContainer.style.display = nowCollapsed ? 'none' : 'block';
            });

            sectionWrapper.appendChild(sectionHeader);

            section.items.forEach(item => {
                if (typeof ToolSectionItem !== 'undefined') {
                    var itemDiv = ToolSectionItem.create(item, section.type, { showIcon: true });
                    itemsContainer.appendChild(itemDiv);
                } else {
                    var itemDiv = document.createElement('div');
                    itemDiv.className = 'unified-item';
                    itemDiv.textContent = item.name || item.asset_id || 'Unnamed';
                    itemsContainer.appendChild(itemDiv);
                }
            });

            sectionWrapper.appendChild(itemsContainer);
            container.appendChild(sectionWrapper);
        });

        if (container.children.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding:8px;color:var(--text-muted);font-size:0.8rem;text-align:center;';
            emptyMsg.textContent = 'No items yet';
            container.appendChild(emptyMsg);
        }
    }

    function renderUnifiedFolderView(container, savedMeasurements) {
        const allGroups = [];
        const seen = new Set();

        [...state.sheetGroups, ...state.assetGroups, ...state.linkGroups, ...state.measurementGroups].forEach(g => {
            if (!seen.has(g.id) && !g.parent_group) {
                seen.add(g.id);
                allGroups.push(g);
            }
        });

        allGroups.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        const ungroupedSheets = state.sheets.filter(s => !s.layer_group);
        const ungroupedAssets = state.assets.filter(a => !a.layer_group);
        const ungroupedLinks = state.links.filter(l => !l.layer_group);
        const ungroupedMeasurements = savedMeasurements.filter(m => !m.layer_group);

        const totalUngrouped = ungroupedSheets.length + ungroupedAssets.length +
                               ungroupedLinks.length + ungroupedMeasurements.length;

        if (totalUngrouped > 0) {
            const ungroupedSection = createUnifiedFolderSection(
                { id: 'ungrouped', name: 'Ungrouped', scope: 'local' },
                [...ungroupedSheets, ...ungroupedAssets, ...ungroupedLinks, ...ungroupedMeasurements],
                { sheets: ungroupedSheets, assets: ungroupedAssets, links: ungroupedLinks, measurements: ungroupedMeasurements },
                0
            );
            container.appendChild(ungroupedSection);
        }

        allGroups.forEach(group => {
            const folderEl = createUnifiedFolderSection(group, null, null, 0, savedMeasurements);
            container.appendChild(folderEl);
        });

        if (container.children.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding:8px;color:var(--text-muted);font-size:0.8rem;text-align:center;';
            emptyMsg.textContent = 'No items yet';
            container.appendChild(emptyMsg);
        }
    }

    function createUnifiedFolderSection(group, itemsOverride, itemsByType, depth, allMeasurements) {
        const wrapper = document.createElement('div');
        wrapper.className = 'unified-folder-section';
        wrapper.style.marginLeft = (depth * 12) + 'px';

        var folderSheets, folderAssets, folderLinks, folderMeasurements;

        if (itemsByType) {
            folderSheets = itemsByType.sheets || [];
            folderAssets = itemsByType.assets || [];
            folderLinks = itemsByType.links || [];
            folderMeasurements = itemsByType.measurements || [];
        } else {
            var measurements = allMeasurements || ((typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : []);
            folderSheets = state.sheets.filter(s => s.layer_group === group.id);
            folderAssets = state.assets.filter(a => a.layer_group === group.id);
            folderLinks = state.links.filter(l => l.layer_group === group.id);
            folderMeasurements = measurements.filter(m => m.layer_group === group.id);
        }

        var directItemCount = folderSheets.length + folderAssets.length +
                              folderLinks.length + folderMeasurements.length;

        var totalCount = directItemCount;
        if (group.child_groups && group.child_groups.length > 0) {
            group.child_groups.forEach(child => {
                totalCount += getGroupItemCountForType(child, 'sheet', true);
                totalCount += getGroupItemCountForType(child, 'asset', true);
                totalCount += getGroupItemCountForType(child, 'link', true);
                totalCount += getGroupItemCountForType(child, 'measurement', true);
            });
        }

        var hasContent = totalCount > 0 || (group.child_groups && group.child_groups.length > 0);
        var isCollapsed = window.unifiedFolderCollapsed[group.id];

        // Folder header
        const header = document.createElement('div');
        header.className = 'unified-folder-header';
        header.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px;background:var(--bg-secondary);border-radius:4px;margin:2px 0;cursor:pointer;user-select:none;font-size:0.8rem;';

        const chevron = document.createElement('span');
        chevron.textContent = hasContent ? (isCollapsed ? '\u25B6' : '\u25BC') : '\u2022';
        chevron.style.cssText = 'font-size:0.7rem;width:12px;';

        const icon = document.createElement('span');
        icon.textContent = group.scope === 'global' ? '\u{1F310}' : '\u{1F4C1}';

        const name = document.createElement('span');
        name.textContent = group.name;
        name.style.flex = '1';

        const count = document.createElement('span');
        count.textContent = totalCount;
        count.style.cssText = 'font-size:0.7rem;padding:1px 6px;background:var(--bg-tertiary);border-radius:10px;color:var(--text-muted);';

        header.appendChild(chevron);
        header.appendChild(icon);
        header.appendChild(name);
        header.appendChild(count);

        const content = document.createElement('div');
        content.className = 'unified-folder-content';
        if (isCollapsed) {
            content.style.display = 'none';
        }

        header.addEventListener('click', function() {
            var nowCollapsed = !window.unifiedFolderCollapsed[group.id];
            window.unifiedFolderCollapsed[group.id] = nowCollapsed;
            chevron.textContent = hasContent ? (nowCollapsed ? '\u25B6' : '\u25BC') : '\u2022';
            content.style.display = nowCollapsed ? 'none' : 'block';
        });

        // Child folders first
        if (group.child_groups && group.child_groups.length > 0) {
            group.child_groups.forEach(child => {
                var childEl = createUnifiedFolderSection(child, null, null, depth + 1, allMeasurements);
                content.appendChild(childEl);
            });
        }

        // Items organized by type
        var itemTypes = [
            { items: folderSheets, type: 'sheet', icon: '\u{1F4C4}' },
            { items: folderAssets, type: 'asset', icon: '\u{1F4CD}' },
            { items: folderLinks, type: 'link', icon: '\u{1F517}' },
            { items: folderMeasurements, type: 'measurement', icon: '\u{1F4D0}' }
        ];

        itemTypes.forEach(function(entry) {
            entry.items.forEach(item => {
                if (typeof ToolSectionItem !== 'undefined') {
                    var itemDiv = ToolSectionItem.create(item, entry.type, { showIcon: true });
                    itemDiv.style.marginLeft = '12px';
                    content.appendChild(itemDiv);
                } else {
                    var itemDiv = document.createElement('div');
                    itemDiv.className = 'unified-item';
                    itemDiv.style.marginLeft = '12px';
                    itemDiv.textContent = entry.icon + ' ' + (item.name || item.asset_id || 'Unnamed');
                    content.appendChild(itemDiv);
                }
            });
        });

        wrapper.appendChild(header);
        wrapper.appendChild(content);
        return wrapper;
    }

    // ==================== Type-Specific Renderers ====================

    function renderAssetGroupList() {
        const container = document.getElementById('asset-groups-list');
        if (!container) {
            console.warn('Asset groups container not found');
            return;
        }

        container.innerHTML = '';

        if (!state.assets) {
            console.warn('state.assets is undefined');
            return;
        }

        console.log('Rendering asset groups. Total assets:', state.assets.length);

        const ungroupedAssets = state.assets.filter(a => !a.layer_group);
        if (ungroupedAssets.length > 0) {
            container.appendChild(createUngroupedFolder('asset', ungroupedAssets.length));
        }

        var localGroups = state.assetGroups.filter(g => !g.parent_group && g.group_type === 'asset' && g.scope === 'local');
        localGroups.forEach(group => {
            container.appendChild(createGroupItem(group, 'asset', 0));
        });

        var globalGroups = getAllGlobalGroups();
        globalGroups.forEach(group => {
            container.appendChild(createGroupItem(group, 'asset', 0, true));
        });
    }

    function renderLinkGroupList() {
        const container = document.getElementById('link-groups-list');
        if (!container) {
            console.warn('Link groups container not found');
            return;
        }

        container.innerHTML = '';

        if (!state.links) {
            console.warn('state.links is undefined');
            return;
        }

        console.log('Rendering link groups. Total links:', state.links.length);

        const ungroupedLinks = state.links.filter(l => !l.layer_group);
        if (ungroupedLinks.length > 0) {
            container.appendChild(createUngroupedFolder('link', ungroupedLinks.length));
        }

        var localGroups = state.linkGroups.filter(g => !g.parent_group && g.group_type === 'link' && g.scope === 'local');
        localGroups.forEach(group => {
            container.appendChild(createGroupItem(group, 'link', 0));
        });

        var globalGroups = getAllGlobalGroups();
        globalGroups.forEach(group => {
            container.appendChild(createGroupItem(group, 'link', 0, true));
        });
    }

    async function renderMeasurementGroupList() {
        const container = document.getElementById('measurement-groups-list');
        if (!container) return;

        container.innerHTML = '';

        if (typeof MeasurementTool !== 'undefined' && typeof MeasurementTool.loadSaved === 'function') {
            await MeasurementTool.loadSaved();
        }

        const savedMeasurements = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : [];

        const ungroupedMeasurements = savedMeasurements.filter(m => !m.layer_group);
        if (ungroupedMeasurements.length > 0) {
            container.appendChild(createUngroupedFolder('measurement', ungroupedMeasurements.length));
        }

        var localGroups = state.measurementGroups.filter(g => !g.parent_group && g.group_type === 'measurement' && g.scope === 'local');
        localGroups.forEach(group => {
            container.appendChild(createGroupItem(group, 'measurement', 0));
        });

        var globalGroups = getAllGlobalGroups();
        globalGroups.forEach(group => {
            container.appendChild(createGroupItem(group, 'measurement', 0, true));
        });
    }

    function renderSheetGroupList() {
        const container = document.getElementById('sheet-layers');
        if (!container) return;

        container.innerHTML = '';

        var globalGroups = getAllGlobalGroups();
        var hasSheetGroups = (state.sheetGroups && state.sheetGroups.length > 0) || globalGroups.length > 0;

        var ungroupedSheets = state.sheets.filter(s => !s.layer_group);

        if (hasSheetGroups) {
            if (ungroupedSheets.length > 0) {
                container.appendChild(createUngroupedFolder('sheet', ungroupedSheets.length));
            }

            var localGroups = state.sheetGroups.filter(g => !g.parent_group && g.scope === 'local');
            localGroups.forEach(group => {
                container.appendChild(createGroupItem(group, 'sheet', 0));
            });

            globalGroups.forEach(group => {
                container.appendChild(createGroupItem(group, 'sheet', 0, true));
            });
        } else {
            state.sheets.forEach(sheet => {
                var div = document.createElement('div');
                div.className = 'layer-item';
                div.dataset.sheetId = sheet.id;

                var checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'layer-visibility';
                checkbox.checked = true;
                checkbox.addEventListener('change', function() {
                    if (typeof toggleSheetVisibility === 'function') {
                        toggleSheetVisibility(sheet.id, this.checked);
                    }
                });

                var span = document.createElement('span');
                span.textContent = sheet.name;

                div.appendChild(checkbox);
                div.appendChild(span);

                div.addEventListener('click', function(e) {
                    if (e.target.type !== 'checkbox') {
                        if (typeof selectSheet === 'function') selectSheet(sheet.id);
                    }
                });
                container.appendChild(div);
            });
        }
    }

    // ==================== Item & Folder Elements ====================

    function createSheetItem(sheet) {
        if (typeof ToolSectionItem !== 'undefined') {
            return ToolSectionItem.create(sheet, 'sheet');
        }

        var div = document.createElement('div');
        div.className = 'folder-item-entry sheet-item';
        div.dataset.sheetId = sheet.id;
        div.draggable = true;

        var nameSpan = document.createElement('span');
        nameSpan.className = 'item-name';
        nameSpan.textContent = sheet.name;
        div.appendChild(nameSpan);

        div.addEventListener('click', function() {
            if (typeof selectSheet === 'function') selectSheet(sheet.id);
        });

        return div;
    }

    function createUngroupedFolder(type, count) {
        var div = document.createElement('div');
        div.className = 'group-item ungrouped-folder';
        div.dataset.groupType = type;

        // Drop target to unassign items
        div.addEventListener('dragover', function(e) {
            e.preventDefault();
            if (state.draggedItem && state.draggedItem.type === type) {
                div.classList.add('drop-target-active');
            }
        });

        div.addEventListener('dragleave', function() {
            div.classList.remove('drop-target-active');
        });

        div.addEventListener('drop', async function(e) {
            e.preventDefault();
            div.classList.remove('drop-target-active');
            if (state.draggedItem && state.draggedItem.type === type) {
                await removeItemFromGroup(state.draggedItem.type, state.draggedItem.id);
                state.draggedItem = null;
            }
        });

        var folderIcon = document.createElement('span');
        folderIcon.className = 'folder-icon';
        folderIcon.textContent = '\u{1F4C1}';
        folderIcon.style.marginRight = '6px';

        var nameSpan = document.createElement('span');
        nameSpan.className = 'group-name';
        nameSpan.textContent = 'Ungrouped';

        var countBadge = document.createElement('span');
        countBadge.className = 'group-count';
        countBadge.textContent = count;

        var toggleBtn = document.createElement('button');
        toggleBtn.className = 'folder-toggle';
        toggleBtn.textContent = '\u25BC';
        toggleBtn.title = 'Toggle folder';
        toggleBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var itemsList = div.querySelector('.folder-items');
            if (itemsList) {
                itemsList.classList.toggle('collapsed');
                toggleBtn.textContent = itemsList.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
            }
        });

        div.appendChild(toggleBtn);
        div.appendChild(folderIcon);
        div.appendChild(nameSpan);
        div.appendChild(countBadge);

        var itemsList = document.createElement('div');
        itemsList.className = 'folder-items' + (count > 10 ? ' collapsed' : '');

        var items;
        if (type === 'asset') {
            items = state.assets.filter(a => !a.layer_group);
        } else if (type === 'sheet') {
            items = state.sheets.filter(s => !s.layer_group);
        } else if (type === 'link') {
            items = state.links.filter(l => !l.layer_group);
        } else if (type === 'measurement') {
            items = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements().filter(m => !m.layer_group) : [];
        } else {
            items = [];
        }

        items.forEach(item => {
            var itemDiv = type === 'sheet'
                ? createSheetItem(item)
                : createFolderItemElement(item, type);
            itemsList.appendChild(itemDiv);
        });

        div.appendChild(itemsList);

        if (count > 10) {
            toggleBtn.textContent = '\u25B6';
        }

        return div;
    }

    function createGroupItem(group, type, depth, isGlobalCrossType) {
        if (depth === undefined) depth = 0;
        if (isGlobalCrossType === undefined) isGlobalCrossType = false;

        var div = document.createElement('div');
        div.className = 'group-item folder-item';
        if (isGlobalCrossType) {
            div.classList.add('global-folder');
        }
        div.dataset.groupId = group.id;
        div.dataset.groupType = type;
        div.dataset.originalType = group.group_type;
        div.style.marginLeft = (depth * 12) + 'px';

        // Folder draggable for nesting
        div.draggable = true;
        div.addEventListener('dragstart', function(e) {
            e.stopPropagation();
            draggedFolder = { id: group.id, type: group.group_type, element: div };
            state.draggedItem = null;
            div.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        div.addEventListener('dragend', function() {
            div.classList.remove('dragging');
            draggedFolder = null;
        });

        // Drop target for items AND folders
        div.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.stopPropagation();

            if (state.draggedItem) {
                var canAccept = group.scope === 'global' || state.draggedItem.type === type;
                if (canAccept) {
                    div.classList.add('drop-target-active');
                }
            } else if (draggedFolder && draggedFolder.id !== group.id) {
                var canAccept = draggedFolder.type === group.group_type;
                if (canAccept) {
                    div.classList.add('drop-target-active');
                }
            }
        });

        div.addEventListener('dragleave', function() {
            div.classList.remove('drop-target-active');
        });

        div.addEventListener('drop', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            div.classList.remove('drop-target-active');

            if (state.draggedItem) {
                var canAccept = group.scope === 'global' || state.draggedItem.type === type;
                if (canAccept) {
                    await moveItemToGroup(group.id, state.draggedItem.type, state.draggedItem.id);
                    state.draggedItem = null;
                }
            } else if (draggedFolder && draggedFolder.id !== group.id) {
                var canAccept = draggedFolder.type === group.group_type;
                if (canAccept) {
                    await joinGroups(group.id, draggedFolder.id);
                    draggedFolder = null;
                }
            }
        });

        // Context-aware item count
        var contextItemCount = getGroupItemCountForType(group, type);

        // Toggle button
        var toggleBtn = document.createElement('button');
        toggleBtn.className = 'folder-toggle';
        var hasChildren = (group.child_groups && group.child_groups.length > 0) || contextItemCount > 0;
        toggleBtn.textContent = hasChildren ? '\u25BC' : '\u2022';
        toggleBtn.title = hasChildren ? 'Toggle folder' : '';
        toggleBtn.disabled = !hasChildren;
        toggleBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            var content = div.querySelector('.folder-content');
            if (content) {
                content.classList.toggle('collapsed');
                toggleBtn.textContent = content.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
            }
        });

        // Visibility checkbox
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.groupVisibility[group.id] !== false;
        checkbox.className = 'group-visibility';
        checkbox.title = 'Toggle group visibility';
        checkbox.addEventListener('click', function(e) { e.stopPropagation(); });
        checkbox.addEventListener('change', function() { toggleLayerGroupVisibility(group.id, checkbox.checked); });

        // Folder icon
        var folderIcon = document.createElement('span');
        folderIcon.className = 'folder-icon';
        folderIcon.textContent = group.scope === 'global' ? '\u{1F310}' : '\u{1F4C1}';
        folderIcon.title = group.scope === 'global' ? 'Global folder (accepts all item types)' : 'Local folder';

        // Name
        var nameSpan = document.createElement('span');
        nameSpan.className = 'group-name';
        nameSpan.textContent = group.name;
        nameSpan.title = group.name + (isGlobalCrossType ? ' (' + group.group_type + ' folder)' : '');

        // Count badge
        var countBadge = document.createElement('span');
        countBadge.className = 'group-count';
        countBadge.textContent = contextItemCount;

        // Settings button
        var settingsBtn = document.createElement('button');
        settingsBtn.className = 'folder-settings';
        settingsBtn.textContent = '\u2699';
        settingsBtn.title = 'Folder settings';
        settingsBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            showFolderSettingsMenu(group, type, settingsBtn);
        });

        // Delete button
        var delBtn = document.createElement('button');
        delBtn.className = 'folder-delete';
        delBtn.textContent = '\u00D7';
        delBtn.title = 'Delete folder';
        delBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            deleteLayerGroup(group.id, group.name);
        });

        div.appendChild(toggleBtn);
        div.appendChild(checkbox);
        div.appendChild(folderIcon);
        div.appendChild(nameSpan);
        div.appendChild(countBadge);
        div.appendChild(settingsBtn);
        div.appendChild(delBtn);

        // Folder content (children + items)
        var folderContent = document.createElement('div');
        folderContent.className = 'folder-content';

        if (group.child_groups && group.child_groups.length > 0) {
            group.child_groups.forEach(child => {
                folderContent.appendChild(createGroupItem(child, type, depth + 1));
            });
        }

        var groupItems;
        if (type === 'asset') {
            groupItems = state.assets.filter(a => a.layer_group === group.id);
        } else if (type === 'sheet') {
            groupItems = state.sheets.filter(s => s.layer_group === group.id);
        } else if (type === 'measurement') {
            var savedMeasurements = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : [];
            groupItems = savedMeasurements.filter(m => m.layer_group === group.id);
        } else {
            groupItems = state.links.filter(l => l.layer_group === group.id);
        }

        groupItems.forEach(item => {
            var itemDiv = type === 'sheet'
                ? createSheetItem(item)
                : createFolderItemElement(item, type);
            folderContent.appendChild(itemDiv);
        });

        div.appendChild(folderContent);
        return div;
    }

    function createFolderItemElement(item, type) {
        if (typeof ToolSectionItem !== 'undefined') {
            return ToolSectionItem.create(item, type);
        }

        var div = document.createElement('div');
        div.className = 'folder-item-entry';
        div.dataset.itemId = item.id;
        div.dataset.itemType = type;

        var nameSpan = document.createElement('span');
        nameSpan.className = 'item-name';
        nameSpan.textContent = item.name || item.asset_id || item.link_id || 'Unnamed';
        div.appendChild(nameSpan);

        return div;
    }

    // ==================== Folder Settings Menu ====================

    function showFolderSettingsMenu(group, type, anchorEl) {
        var existingMenu = document.querySelector('.folder-settings-menu');
        if (existingMenu) existingMenu.remove();

        var menu = document.createElement('div');
        menu.className = 'folder-settings-menu';

        var ungroupedItems;
        if (type === 'asset') {
            ungroupedItems = state.assets.filter(a => !a.layer_group);
        } else if (type === 'sheet') {
            ungroupedItems = state.sheets.filter(s => !s.layer_group);
        } else if (type === 'measurement') {
            var savedMeasurements = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : [];
            ungroupedItems = savedMeasurements.filter(m => !m.layer_group);
        } else {
            ungroupedItems = state.links.filter(l => !l.layer_group);
        }

        var contextItemCount = getGroupItemCountForType(group, type);

        var options = [
            {
                label: 'Assign all ungrouped (' + ungroupedItems.length + ')',
                icon: '\u{1F4E5}',
                disabled: ungroupedItems.length === 0,
                action: function() { assignAllUngroupedToGroup(group.id, type); }
            },
            {
                label: 'Rename folder',
                icon: '\u270F\uFE0F',
                action: function() { renameGroup(group.id, group.name); }
            },
            {
                label: 'Change color',
                icon: '\u{1F3A8}',
                action: function() { changeGroupColor(group.id, group.color); }
            },
            {
                label: 'Create subfolder',
                icon: '\u{1F4C1}',
                action: function() { createSubfolder(group.id, type); }
            },
            { separator: true },
            {
                label: 'Move folder to...',
                icon: '\u2197\uFE0F',
                action: function() { showMoveGroupDialog(group, type); }
            },
            {
                label: 'Move contents to...',
                icon: '\u{1F4E6}',
                disabled: contextItemCount === 0,
                action: function() { showMoveContentsDialog(group, type); }
            },
            {
                label: 'Ungroup all items',
                icon: '\u{1F4E4}',
                disabled: contextItemCount === 0,
                action: function() { ungroupAllItems(group.id, type); }
            }
        ];

        options.forEach(opt => {
            if (opt.separator) {
                var sep = document.createElement('div');
                sep.className = 'menu-separator';
                menu.appendChild(sep);
            } else {
                var item = document.createElement('div');
                item.className = 'menu-item' + (opt.disabled ? ' disabled' : '');
                item.innerHTML = '<span class="menu-icon">' + opt.icon + '</span> ' + opt.label;
                if (!opt.disabled) {
                    item.addEventListener('click', function() {
                        menu.remove();
                        opt.action();
                    });
                }
                menu.appendChild(item);
            }
        });

        var rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = rect.bottom + 'px';
        menu.style.left = rect.left + 'px';
        menu.style.zIndex = '9999';

        document.body.appendChild(menu);

        var closeHandler = function(e) {
            if (!menu.contains(e.target) && e.target !== anchorEl) {
                menu.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(function() { document.addEventListener('click', closeHandler); }, 0);
    }

    // ==================== Folder Actions ====================

    async function assignAllUngroupedToGroup(groupId, type) {
        var items;
        if (type === 'asset') {
            items = state.assets.filter(a => !a.layer_group);
        } else if (type === 'sheet') {
            items = state.sheets.filter(s => !s.layer_group);
        } else if (type === 'measurement') {
            var savedMeasurements = (typeof MeasurementTool !== 'undefined') ? MeasurementTool.getSavedMeasurements() : [];
            items = savedMeasurements.filter(m => !m.layer_group);
        } else {
            items = state.links.filter(l => !l.layer_group);
        }

        if (items.length === 0) return;
        if (!confirm('Assign ' + items.length + ' ungrouped ' + type + 's to this folder?')) return;

        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/assign-ungrouped/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ item_type: type })
            });

            if (resp.ok) {
                if (typeof loadProjectData === 'function') await loadProjectData();
            } else {
                var data = await resp.json();
                alert(data.error || 'Failed to assign items');
            }
        } catch (err) {
            console.error('Error assigning ungrouped items:', err);
            alert('Error assigning items');
        }
    }

    async function removeItemFromGroup(itemType, itemId) {
        try {
            var endpoint;
            if (itemType === 'asset') {
                endpoint = 'assets';
            } else if (itemType === 'sheet') {
                endpoint = 'sheets';
            } else {
                endpoint = 'links';
            }
            var resp = await fetch('/api/' + endpoint + '/' + itemId + '/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ layer_group: null })
            });

            if (resp.ok) {
                if (typeof loadProjectData === 'function') await loadProjectData();
            }
        } catch (err) {
            console.error('Error removing item from group:', err);
        }
    }

    async function renameGroup(groupId, currentName) {
        var newName = prompt('Enter new folder name:', currentName);
        if (!newName || newName === currentName) return;

        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ name: newName })
            });

            if (resp.ok) {
                await loadLayerGroups();
            }
        } catch (err) {
            console.error('Error renaming group:', err);
        }
    }

    async function changeGroupColor(groupId, currentColor) {
        var newColor = prompt('Enter color (hex, e.g., #3498db):', currentColor || '#3498db');
        if (!newColor) return;

        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ color: newColor })
            });

            if (resp.ok) {
                await loadLayerGroups();
            }
        } catch (err) {
            console.error('Error changing group color:', err);
        }
    }

    async function createSubfolder(parentId, type) {
        var name = prompt('Enter subfolder name:');
        if (!name) return;

        try {
            var resp = await fetch('/api/projects/' + PROJECT_ID + '/layer-groups/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    name: name,
                    group_type: type,
                    parent_group: parentId
                })
            });

            if (resp.ok) {
                await loadLayerGroups();
            } else {
                var data = await resp.json();
                alert(data.error || 'Failed to create subfolder');
            }
        } catch (err) {
            console.error('Error creating subfolder:', err);
        }
    }

    // ==================== Move & Join Dialogs ====================

    function showMoveGroupDialog(group, type) {
        var typeGroups;
        if (type === 'asset') {
            typeGroups = state.assetGroups;
        } else if (type === 'link') {
            typeGroups = state.linkGroups;
        } else if (type === 'sheet') {
            typeGroups = state.sheetGroups;
        } else if (type === 'measurement') {
            typeGroups = state.measurementGroups;
        } else {
            typeGroups = [];
        }

        var flatTypeGroups = flattenGroupHierarchy(typeGroups);

        var allRootGroups = [...state.assetGroups, ...state.linkGroups, ...state.sheetGroups, ...state.measurementGroups];
        var globalRootGroups = allRootGroups.filter(g => g.scope === 'global');
        var flatGlobalGroups = flattenGroupHierarchy(globalRootGroups);

        var seen = new Set();
        var allFlattened = [];

        flatTypeGroups.forEach(item => {
            if (!seen.has(item.group.id)) {
                seen.add(item.group.id);
                allFlattened.push(item);
            }
        });

        flatGlobalGroups.forEach(item => {
            if (!seen.has(item.group.id)) {
                seen.add(item.group.id);
                allFlattened.push(item);
            }
        });

        var availableParents = allFlattened.filter(item =>
            item.group.id !== group.id &&
            item.group.id !== group.parent_group &&
            !isDescendantOf(item.group, group)
        );

        var canMoveToRoot = group.parent_group !== null;

        if (availableParents.length === 0 && !canMoveToRoot) {
            alert('No other folders available to move to. This folder is already at root level with no other folders.');
            return;
        }

        var options = [];
        if (canMoveToRoot) {
            options.push('(Root level - no parent)');
        }

        availableParents.forEach(item => {
            var indent = '  '.repeat(item.depth);
            var prefix = item.group.scope === 'global' ? '\u{1F310} ' : '\u{1F4C1} ';
            options.push(indent + prefix + item.group.name);
        });

        var choice = prompt('Move "' + group.name + '" to:\n\n' + options.map(function(o, i) { return i + ': ' + o; }).join('\n') + '\n\nEnter number:');

        if (choice === null) return;
        var idx = parseInt(choice);
        if (isNaN(idx) || idx < 0 || idx >= options.length) {
            alert('Invalid selection');
            return;
        }

        var newParentId;
        if (canMoveToRoot && idx === 0) {
            newParentId = null;
        } else {
            var folderIdx = canMoveToRoot ? idx - 1 : idx;
            newParentId = availableParents[folderIdx].group.id;
        }

        moveGroupToParent(group.id, newParentId);
    }

    async function moveGroupToParent(groupId, newParentId) {
        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ parent_group: newParentId })
            });

            if (resp.ok) {
                await loadLayerGroups();
            }
        } catch (err) {
            console.error('Error moving group:', err);
        }
    }

    function showMoveContentsDialog(group, type) {
        var typeGroups;
        if (type === 'asset') {
            typeGroups = state.assetGroups;
        } else if (type === 'link') {
            typeGroups = state.linkGroups;
        } else if (type === 'sheet') {
            typeGroups = state.sheetGroups;
        } else if (type === 'measurement') {
            typeGroups = state.measurementGroups;
        } else {
            typeGroups = [];
        }

        var flatTypeGroups = flattenGroupHierarchy(typeGroups);

        var allRootGroups = [...state.assetGroups, ...state.linkGroups, ...state.sheetGroups, ...state.measurementGroups];
        var globalRootGroups = allRootGroups.filter(g => g.scope === 'global');
        var flatGlobalGroups = flattenGroupHierarchy(globalRootGroups);

        var seen = new Set();
        var allFlattened = [];

        flatTypeGroups.forEach(item => {
            if (!seen.has(item.group.id)) {
                seen.add(item.group.id);
                allFlattened.push(item);
            }
        });

        flatGlobalGroups.forEach(item => {
            if (!seen.has(item.group.id)) {
                seen.add(item.group.id);
                allFlattened.push(item);
            }
        });

        var availableTargets = allFlattened.filter(item =>
            item.group.id !== group.id
        );

        if (availableTargets.length === 0) {
            alert('No other folders available to move contents to.');
            return;
        }

        var options = ['(Ungrouped - remove from folder)'];
        availableTargets.forEach(function(item) {
            var indent = '  '.repeat(item.depth);
            var prefix = item.group.scope === 'global' ? '\u{1F310} ' : '\u{1F4C1} ';
            var isSubfolder = isDescendantOf(item.group, group);
            var marker = isSubfolder ? ' \u2B07\uFE0F' : '';
            options.push(indent + prefix + item.group.name + marker);
        });

        var typeLabel = type === 'asset' ? 'assets' :
                        type === 'sheet' ? 'sheets' :
                        type === 'measurement' ? 'measurements' :
                        type === 'link' ? 'links' : 'items';

        var choice = prompt(
            'Move ' + typeLabel + ' from "' + group.name + '" to:\n\n' +
            options.map(function(o, i) { return i + ': ' + o; }).join('\n') +
            '\n\n(\u2B07\uFE0F = subfolder of this folder)\n\nEnter number:'
        );

        if (choice === null) return;
        var idx = parseInt(choice);
        if (isNaN(idx) || idx < 0 || idx >= options.length) {
            alert('Invalid selection');
            return;
        }

        var targetGroupId = idx === 0 ? null : availableTargets[idx - 1].group.id;
        moveContentsToFolder(group.id, targetGroupId, type);
    }

    async function moveContentsToFolder(sourceGroupId, targetGroupId, type) {
        try {
            var resp = await fetch('/api/layer-groups/' + sourceGroupId + '/move-contents/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    target_group: targetGroupId,
                    item_type: type
                })
            });

            if (resp.ok) {
                var result = await resp.json();
                DW.showToast('Moved ' + (result.moved_count || 0) + ' items', 'success');
                await loadLayerGroups();
                if (typeof loadProjectData === 'function') await loadProjectData();
            } else {
                var data = await resp.json();
                alert(data.error || 'Failed to move contents');
            }
        } catch (err) {
            console.error('Error moving contents:', err);
            alert('Error moving contents');
        }
    }

    async function ungroupAllItems(groupId, type) {
        if (!confirm('Remove all items from this folder? They will become ungrouped.')) return;

        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/ungroup-all/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                }
            });

            if (resp.ok) {
                if (typeof loadProjectData === 'function') await loadProjectData();
            }
        } catch (err) {
            console.error('Error ungrouping items:', err);
        }
    }

    async function toggleLayerGroupVisibility(groupId, visible) {
        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/toggle-visibility/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ visible: visible })
            });

            if (resp.ok) {
                state.groupVisibility[groupId] = visible;
                if (typeof clearAssetsFromCanvas === 'function') clearAssetsFromCanvas();
                if (typeof clearLinksFromCanvas === 'function') clearLinksFromCanvas();
                if (typeof renderAssetsOnCanvas === 'function') renderAssetsOnCanvas();
                if (typeof renderLinksOnCanvas === 'function') renderLinksOnCanvas();
            }
        } catch (err) {
            console.error('Error toggling group visibility:', err);
        }
    }

    function showJoinGroupDialog(group, type) {
        var groups = type === 'asset' ? state.assetGroups : state.linkGroups;
        var otherGroups = groups.filter(g => g.id !== group.id && !g.parent_group);

        if (otherGroups.length === 0) {
            alert('No other groups available to join to.');
            return;
        }

        var groupNames = otherGroups.map(g => g.name).join('\n');
        var parentName = prompt('Join "' + group.name + '" to which group?\n\nAvailable groups:\n' + groupNames);
        if (!parentName) return;

        var parent = otherGroups.find(g => g.name.toLowerCase() === parentName.toLowerCase());
        if (!parent) {
            alert('Group not found');
            return;
        }

        joinGroups(parent.id, group.id);
    }

    async function joinGroups(parentId, childId) {
        try {
            var resp = await fetch('/api/projects/' + PROJECT_ID + '/layer-groups/join/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ parent_id: parentId, child_id: childId })
            });

            if (resp.ok) {
                await loadLayerGroups();
            } else {
                var data = await resp.json();
                alert(data.error || 'Failed to join groups');
            }
        } catch (err) {
            console.error('Error joining groups:', err);
        }
    }

    async function unjoinGroup(groupId) {
        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/unjoin/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': DW.getCSRFToken()
                }
            });

            if (resp.ok) {
                await loadLayerGroups();
            } else {
                var data = await resp.json();
                alert(data.error || 'Failed to unjoin group');
            }
        } catch (err) {
            console.error('Error unjoining group:', err);
        }
    }

    async function deleteLayerGroup(groupId, groupName) {
        if (!confirm('Delete group "' + groupName + '" and all its items?')) return;

        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/', {
                method: 'DELETE',
                headers: {
                    'X-CSRFToken': DW.getCSRFToken()
                }
            });

            if (resp.ok) {
                await loadLayerGroups();
                if (typeof loadProjectData === 'function') await loadProjectData();
            }
        } catch (err) {
            console.error('Error deleting group:', err);
        }
    }

    async function moveItemToGroup(groupId, itemType, itemId) {
        try {
            var resp = await fetch('/api/layer-groups/' + groupId + '/move-item/', {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ item_type: itemType, item_id: itemId })
            });

            if (resp.ok) {
                // Reload layer groups to get updated folder structure
                await loadLayerGroups();
                
                // Only reload the specific item type that was moved, not all project data
                if (itemType === 'measurement') {
                    // Reload measurements and re-render measurement UI
                    if (typeof MeasurementTool !== 'undefined' && MeasurementTool.loadSaved) {
                        await MeasurementTool.loadSaved();
                    }
                    await renderMeasurementGroupList();
                    if (typeof renderUnifiedList === 'function') {
                        renderUnifiedList();
                    }
                } else if (itemType === 'asset') {
                    // Reload assets
                    const assetsResp = await fetch(`/api/projects/${PROJECT_ID}/assets/`);
                    if (assetsResp.ok) {
                        state.assets = await assetsResp.json();
                        window.assets = state.assets;
                    }
                    renderAssetGroupList();
                    if (typeof renderUnifiedList === 'function') {
                        renderUnifiedList();
                    }
                } else if (itemType === 'link') {
                    // Reload links
                    const linksResp = await fetch(`/api/projects/${PROJECT_ID}/links/`);
                    if (linksResp.ok) {
                        state.links = await linksResp.json();
                        window.links = state.links;
                    }
                    renderLinkGroupList();
                    if (typeof renderUnifiedList === 'function') {
                        renderUnifiedList();
                    }
                } else if (itemType === 'sheet') {
                    // Reload sheets
                    const sheetsResp = await fetch(`/api/projects/${PROJECT_ID}/sheets/`);
                    if (sheetsResp.ok) {
                        state.sheets = await sheetsResp.json();
                        window.sheets = state.sheets;
                    }
                    renderSheetGroupList();
                    if (typeof renderUnifiedList === 'function') {
                        renderUnifiedList();
                    }
                }
            } else {
                var data = await resp.json();
                alert(data.error || 'Failed to move item');
            }
        } catch (err) {
            console.error('Error moving item to group:', err);
        }
    }

    // ==================== Canvas Helpers ====================

    function clearAssetsFromCanvas() {
        var canvas = state.canvas;
        if (!canvas) return;
        var assetObjs = canvas.getObjects().filter(obj => obj.assetData);
        assetObjs.forEach(obj => canvas.remove(obj));
    }

    function clearLinksFromCanvas() {
        var canvas = state.canvas;
        if (!canvas) return;
        var linkObjs = canvas.getObjects().filter(obj => obj.isLinkObject);
        linkObjs.forEach(obj => canvas.remove(obj));
    }

    // ==================== Public API ====================

    DW.layers = {
        showCreateGroupModal: showCreateGroupModal,
        hideCreateGroupModal: hideCreateGroupModal,
        createLayerGroup: createLayerGroup,
        loadLayerGroups: loadLayerGroups,
        renderLayerGroupsUI: renderLayerGroupsUI,
        isDescendantOf: isDescendantOf,
        getAllGlobalGroups: getAllGlobalGroups,
        flattenGroupHierarchy: flattenGroupHierarchy,
        getGroupItemCountForType: getGroupItemCountForType,
        toggleUnifiedFolderView: toggleUnifiedFolderView,
        renderUnifiedList: renderUnifiedList,
        renderAssetGroupList: renderAssetGroupList,
        renderLinkGroupList: renderLinkGroupList,
        renderMeasurementGroupList: renderMeasurementGroupList,
        renderSheetGroupList: renderSheetGroupList,
        createSheetItem: createSheetItem,
        createUngroupedFolder: createUngroupedFolder,
        createGroupItem: createGroupItem,
        createFolderItemElement: createFolderItemElement,
        showFolderSettingsMenu: showFolderSettingsMenu,
        assignAllUngroupedToGroup: assignAllUngroupedToGroup,
        removeItemFromGroup: removeItemFromGroup,
        renameGroup: renameGroup,
        changeGroupColor: changeGroupColor,
        createSubfolder: createSubfolder,
        showMoveGroupDialog: showMoveGroupDialog,
        moveGroupToParent: moveGroupToParent,
        showMoveContentsDialog: showMoveContentsDialog,
        moveContentsToFolder: moveContentsToFolder,
        ungroupAllItems: ungroupAllItems,
        toggleLayerGroupVisibility: toggleLayerGroupVisibility,
        showJoinGroupDialog: showJoinGroupDialog,
        joinGroups: joinGroups,
        unjoinGroup: unjoinGroup,
        deleteLayerGroup: deleteLayerGroup,
        moveItemToGroup: moveItemToGroup,
        clearAssetsFromCanvas: clearAssetsFromCanvas,
        clearLinksFromCanvas: clearLinksFromCanvas
    };

    // Backward compatibility
    window.showCreateGroupModal = showCreateGroupModal;
    window.hideCreateGroupModal = hideCreateGroupModal;
    window.createLayerGroup = createLayerGroup;
    window.loadLayerGroups = loadLayerGroups;
    window.renderLayerGroupsUI = renderLayerGroupsUI;
    window.isDescendantOf = isDescendantOf;
    window.getAllGlobalGroups = getAllGlobalGroups;
    window.flattenGroupHierarchy = flattenGroupHierarchy;
    window.getGroupItemCountForType = getGroupItemCountForType;
    window.toggleUnifiedFolderView = toggleUnifiedFolderView;
    window.renderUnifiedList = renderUnifiedList;
    window.renderAssetGroupList = renderAssetGroupList;
    window.renderLinkGroupList = renderLinkGroupList;
    window.renderMeasurementGroupList = renderMeasurementGroupList;
    window.renderSheetGroupList = renderSheetGroupList;
    window.createSheetItem = createSheetItem;
    window.createUngroupedFolder = createUngroupedFolder;
    window.createGroupItem = createGroupItem;
    window.createFolderItemElement = createFolderItemElement;
    window.showFolderSettingsMenu = showFolderSettingsMenu;
    window.assignAllUngroupedToGroup = assignAllUngroupedToGroup;
    window.removeItemFromGroup = removeItemFromGroup;
    window.renameGroup = renameGroup;
    window.changeGroupColor = changeGroupColor;
    window.createSubfolder = createSubfolder;
    window.showMoveGroupDialog = showMoveGroupDialog;
    window.moveGroupToParent = moveGroupToParent;
    window.showMoveContentsDialog = showMoveContentsDialog;
    window.moveContentsToFolder = moveContentsToFolder;
    window.ungroupAllItems = ungroupAllItems;
    window.toggleLayerGroupVisibility = toggleLayerGroupVisibility;
    window.showJoinGroupDialog = showJoinGroupDialog;
    window.joinGroups = joinGroups;
    window.unjoinGroup = unjoinGroup;
    window.deleteLayerGroup = deleteLayerGroup;
    window.moveItemToGroup = moveItemToGroup;
    window.clearAssetsFromCanvas = clearAssetsFromCanvas;
    window.clearLinksFromCanvas = clearLinksFromCanvas;

    console.log('DocuWeaver layers module loaded');
})();
