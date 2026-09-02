/**
 * Unified Tool Section Item Renderer
 * 
 * A reusable module for rendering items across all tool sections:
 * - Sheets
 * - Assets  
 * - Links
 * - Measurements
 * 
 * Usage: ToolSectionItem.create(item, 'measurement', options)
 */
const ToolSectionItem = (function() {
    'use strict';

    // Type-specific configuration
    const TYPE_CONFIG = {
        sheet: {
            icon: '📄',
            iconColor: '#3498db',
            nameField: 'name',
            idField: 'id',
            hasVisibility: true,
            hasDelete: true,
            deleteConfirmText: (item) => `Delete sheet "${item.name}"? This cannot be undone.`,
            onSelect: (item) => typeof selectSheet === 'function' && selectSheet(item.id),
            onDelete: async (item) => {
                // deleteSheet handles confirmation internally, so skip it in the module
                try {
                    const response = await fetch(`/api/sheets/${item.id}/`, {
                        method: 'DELETE',
                        headers: { 'X-CSRFToken': typeof getCSRFToken === 'function' ? getCSRFToken() : '' }
                    });
                    if (response.ok || response.status === 204) {
                        // Remove from canvas
                        if (typeof canvas !== 'undefined') {
                            canvas.getObjects().forEach(obj => {
                                if (obj.sheetData && obj.sheetData.id === item.id) {
                                    canvas.remove(obj);
                                }
                            });
                            canvas.renderAll();
                        }
                        // Remove from local data
                        if (typeof sheets !== 'undefined') {
                            const index = sheets.findIndex(s => s.id === item.id);
                            if (index >= 0) sheets.splice(index, 1);
                        }
                        return true;
                    }
                    return false;
                } catch (e) {
                    console.error('Error deleting sheet:', e);
                    return false;
                }
            },
            onToggleVisibility: (item, visible) => {
                if (typeof toggleSheetVisibility === 'function') {
                    toggleSheetVisibility(item.id, visible);
                }
            },
            refreshList: () => {
                if (typeof renderSheetLayers === 'function') renderSheetLayers();
                if (typeof renderSheetGroupList === 'function') renderSheetGroupList();
            }
        },
        asset: {
            icon: '📍',
            iconColor: '#e74c3c',
            nameField: (item) => item.asset_id || item.name,
            idField: 'id',
            hasVisibility: true,
            hasDelete: true,
            deleteConfirmText: (item) => `Delete asset "${item.asset_id || item.name}"?`,
            onSelect: (item) => typeof selectAsset === 'function' && selectAsset(item.id),
            onDelete: async (item) => {
                try {
                    const response = await fetch(`/api/assets/${item.id}/`, {
                        method: 'DELETE',
                        headers: { 'X-CSRFToken': typeof getCSRFToken === 'function' ? getCSRFToken() : '' }
                    });
                    if (response.ok) {
                        // Reload assets
                        if (typeof PROJECT_ID !== 'undefined') {
                            const assetsResp = await fetch(`/api/projects/${PROJECT_ID}/assets/`);
                            if (typeof assets !== 'undefined') {
                                window.assets = await assetsResp.json();
                            }
                        }
                        return true;
                    }
                    return false;
                } catch (e) {
                    console.error('Error deleting asset:', e);
                    return false;
                }
            },
            onToggleVisibility: (item, visible) => {
                if (typeof toggleAssetVisibility === 'function') {
                    toggleAssetVisibility(item.id, visible);
                }
            },
            refreshList: () => {
                if (typeof renderAssetList === 'function') renderAssetList();
                if (typeof renderAssetGroupList === 'function') renderAssetGroupList();
                if (typeof refreshAssets === 'function') refreshAssets();
            }
        },
        link: {
            icon: null, // Uses color dot instead
            iconColor: (item) => item.color || '#0066FF',
            nameField: (item) => item.name || item.link_id,
            idField: 'id',
            hasVisibility: true,
            hasDelete: true,
            deleteConfirmText: (item) => `Delete link "${item.name || item.link_id}"?`,
            onSelect: null, // Disabled - links are not rendered in correct position when selected from panel
            onDelete: async (item) => {
                try {
                    const response = await fetch(`/api/links/${item.id}/`, {
                        method: 'DELETE',
                        headers: { 'X-CSRFToken': typeof getCSRFToken === 'function' ? getCSRFToken() : '' }
                    });
                    if (response.ok) {
                        // Reload links
                        if (typeof PROJECT_ID !== 'undefined') {
                            const linksResp = await fetch(`/api/projects/${PROJECT_ID}/links/`);
                            if (typeof links !== 'undefined') {
                                window.links = await linksResp.json();
                            }
                        }
                        return true;
                    }
                    return false;
                } catch (e) {
                    console.error('Error deleting link:', e);
                    return false;
                }
            },
            onToggleVisibility: (item, visible) => {
                if (typeof toggleLinkVisibility === 'function') {
                    toggleLinkVisibility(item.id, visible);
                }
            },
            refreshList: () => {
                if (typeof renderLinkList === 'function') renderLinkList();
                if (typeof renderLinkGroupList === 'function') renderLinkGroupList();
            }
        },
        measurement: {
            icon: '📐',
            iconColor: '#00bcd4',
            nameField: 'name',
            idField: 'id',
            hasVisibility: true,
            hasDelete: true,
            deleteConfirmText: (item) => `Delete measurement "${item.name}"?`,
            onSelect: (item) => {
                if (typeof MeasurementTool !== 'undefined' && MeasurementTool.highlightMeasurement) {
                    MeasurementTool.highlightMeasurement(item.id);
                }
            },
            onDelete: async (item) => {
                try {
                    const response = await fetch(`/api/measurement-sets/${item.id}/`, {
                        method: 'DELETE',
                        headers: { 'X-CSRFToken': typeof getCSRFToken === 'function' ? getCSRFToken() : '' }
                    });
                    if (response.ok) {
                        // Update local data
                        if (typeof MeasurementTool !== 'undefined' && MeasurementTool.getSavedMeasurements) {
                            const saved = MeasurementTool.getSavedMeasurements();
                            const index = saved.findIndex(m => m.id === item.id);
                            if (index >= 0) saved.splice(index, 1);
                        }
                        return true;
                    }
                    return false;
                } catch (e) {
                    console.error('Error deleting measurement:', e);
                    return false;
                }
            },
            onToggleVisibility: async (item, visible) => {
                if (typeof MeasurementTool !== 'undefined' && MeasurementTool.toggleVisibility) {
                    await MeasurementTool.toggleVisibility(item.id);
                }
            },
            refreshList: async () => {
                if (typeof renderMeasurementGroupList === 'function') {
                    await renderMeasurementGroupList();
                }
                if (typeof MeasurementTool !== 'undefined' && MeasurementTool.renderSaved) {
                    MeasurementTool.renderSaved();
                }
            }
        }
    };

    /**
     * Get item name based on type configuration
     */
    function getItemName(item, config) {
        if (typeof config.nameField === 'function') {
            return config.nameField(item);
        }
        return item[config.nameField] || 'Unnamed';
    }

    /**
     * Get icon color based on type configuration
     */
    function getIconColor(item, config) {
        if (typeof config.iconColor === 'function') {
            return config.iconColor(item);
        }
        return config.iconColor;
    }

    /**
     * Create the visibility toggle button
     */
    function createVisibilityToggle(item, config) {
        const btn = document.createElement('button');
        btn.className = 'item-visibility-btn';
        btn.textContent = item.visible !== false ? '👁' : '🚫';
        btn.title = item.visible !== false ? 'Hide' : 'Show';
        btn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            padding: 2px 4px;
            font-size: 14px;
            opacity: 0.7;
            transition: opacity 0.2s;
        `;
        
        btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
        btn.addEventListener('mouseleave', () => btn.style.opacity = '0.7');
        
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newVisible = item.visible === false;
            item.visible = newVisible;
            btn.textContent = newVisible ? '👁' : '🚫';
            btn.title = newVisible ? 'Hide' : 'Show';
            
            if (config.onToggleVisibility) {
                await config.onToggleVisibility(item, newVisible);
            }
        });
        
        return btn;
    }

    /**
     * Create the delete button
     */
    function createDeleteButton(item, config) {
        const btn = document.createElement('button');
        btn.className = 'item-delete-btn';
        btn.textContent = '×';
        btn.title = 'Delete';
        btn.style.cssText = `
            background: none;
            border: none;
            cursor: pointer;
            padding: 2px 6px;
            font-size: 16px;
            font-weight: bold;
            color: #e74c3c;
            opacity: 0.6;
            transition: opacity 0.2s;
        `;
        
        btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
        btn.addEventListener('mouseleave', () => btn.style.opacity = '0.6');
        
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            
            const confirmText = typeof config.deleteConfirmText === 'function' 
                ? config.deleteConfirmText(item) 
                : `Delete this item?`;
            
            if (!confirm(confirmText)) return;
            
            if (config.onDelete) {
                const success = await config.onDelete(item);
                if (success && config.refreshList) {
                    await config.refreshList();
                }
                if (success && typeof showToast === 'function') {
                    showToast(`Deleted successfully`, 'success');
                }
            }
        });
        
        return btn;
    }

    /**
     * Create the item icon/indicator
     */
    function createItemIcon(item, config) {
        const indicator = document.createElement('span');
        indicator.className = 'item-indicator';
        
        if (config.icon) {
            // Use emoji icon
            indicator.textContent = config.icon;
            indicator.style.cssText = `
                margin-right: 6px;
                font-size: 14px;
                color: ${getIconColor(item, config)};
            `;
        } else {
            // Use color dot (for links)
            indicator.style.cssText = `
                display: inline-block;
                width: 10px;
                height: 10px;
                border-radius: 2px;
                background-color: ${getIconColor(item, config)};
                margin-right: 6px;
                flex-shrink: 0;
            `;
        }
        
        return indicator;
    }

    /**
     * Create a unified item element for any type
     * @param {Object} item - The item data
     * @param {string} type - The type of item (sheet, asset, link, measurement)
     * @param {Object} options - Optional configuration overrides
     * @param {boolean} options.showIcon - Whether to show the icon (default: false, set true for unified lists)
     */
    function create(item, type, options = {}) {
        const config = { ...TYPE_CONFIG[type], ...options };
        
        if (!config) {
            console.error(`Unknown item type: ${type}`);
            return document.createElement('div');
        }

        const div = document.createElement('div');
        div.className = 'tool-section-item folder-item-entry';
        div.dataset.itemId = item.id || item[config.idField];
        div.dataset.itemType = type;

        // Make draggable
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            // Set both window.draggedItem and state.draggedItem for compatibility
            const dragData = { type: type, id: item.id, element: div };
            window.draggedItem = dragData;
            
            // Also set in DocuWeaver state if available
            if (typeof DocuWeaver !== 'undefined' && DocuWeaver.state) {
                DocuWeaver.state.draggedItem = dragData;
            }
            
            div.classList.add('dragging');
            e.stopPropagation();
        });
        div.addEventListener('dragend', () => {
            div.classList.remove('dragging');
            window.draggedItem = null;
            
            // Clear from DocuWeaver state if available
            if (typeof DocuWeaver !== 'undefined' && DocuWeaver.state) {
                DocuWeaver.state.draggedItem = null;
            }
        });

        // Create left section (name only, icon removed from individual items)
        const leftSection = document.createElement('div');
        leftSection.className = 'item-left';
        leftSection.style.cssText = `
            display: flex;
            align-items: center;
            flex: 1;
            min-width: 0;
            overflow: hidden;
        `;

        // Only show item icon if explicitly requested (for unified/mixed lists)
        if (options.showIcon) {
            const icon = createItemIcon(item, config);
            leftSection.appendChild(icon);
        }

        // Item name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'item-name';
        nameSpan.textContent = getItemName(item, config);
        nameSpan.title = nameSpan.textContent;
        nameSpan.style.cssText = `
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        leftSection.appendChild(nameSpan);

        div.appendChild(leftSection);

        // Create right section (actions)
        const rightSection = document.createElement('div');
        rightSection.className = 'item-actions';
        rightSection.style.cssText = `
            display: flex;
            align-items: center;
            gap: 2px;
            margin-left: auto;
        `;

        // Visibility toggle
        if (config.hasVisibility) {
            const visBtn = createVisibilityToggle(item, config);
            rightSection.appendChild(visBtn);
        }

        // Delete button
        if (config.hasDelete) {
            const delBtn = createDeleteButton(item, config);
            rightSection.appendChild(delBtn);
        }

        div.appendChild(rightSection);

        // Click to select
        div.addEventListener('click', (e) => {
            // Don't trigger select if clicking action buttons
            if (e.target.closest('.item-actions')) return;
            
            if (config.onSelect) {
                config.onSelect(item);
            }
        });

        // Apply styling
        const cursorStyle = config.onSelect ? 'pointer' : 'default';
        div.style.cssText = `
            display: flex;
            align-items: center;
            padding: 4px 8px;
            cursor: ${cursorStyle};
            border-radius: 4px;
            transition: background-color 0.15s;
            font-size: 0.85rem;
        `;

        div.addEventListener('mouseenter', () => {
            div.style.backgroundColor = 'var(--hover-bg, rgba(0,0,0,0.05))';
        });
        div.addEventListener('mouseleave', () => {
            div.style.backgroundColor = '';
        });

        return div;
    }

    /**
     * Render a list of items into a container
     */
    function renderList(container, items, type, options = {}) {
        if (!container) return;
        
        // Clear existing items
        container.innerHTML = '';
        
        if (!items || items.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-list-message';
            emptyMsg.textContent = options.emptyMessage || `No ${type}s found`;
            emptyMsg.style.cssText = `
                padding: 12px;
                text-align: center;
                color: var(--text-secondary, #888);
                font-size: 0.85rem;
                font-style: italic;
            `;
            container.appendChild(emptyMsg);
            return;
        }
        
        items.forEach(item => {
            const itemEl = create(item, type, options);
            container.appendChild(itemEl);
        });
    }

    /**
     * Get configuration for a type
     */
    function getConfig(type) {
        return TYPE_CONFIG[type] || null;
    }

    /**
     * Register a custom type or extend existing one
     */
    function registerType(typeName, config) {
        TYPE_CONFIG[typeName] = { ...TYPE_CONFIG[typeName], ...config };
    }

    // Public API
    return {
        create,
        renderList,
        getConfig,
        registerType,
        TYPE_CONFIG
    };
})();

// Make available globally
window.ToolSectionItem = ToolSectionItem;
