/**
 * DocuWeaver Canvas Editor - Sidebar Module
 *
 * Handles sidebar toggle/collapse, tab switching, import dropdown,
 * canvas resizing, and layer section drag-sorting.
 *
 * Depends on: namespace.js
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // ==================== Private State ====================

    /** Currently dragged layer section for reordering */
    let draggedSection = null;

    // ==================== Tab Switching ====================

    function showTab(tabName) {
        document.querySelectorAll('.tab').forEach(function(tab) {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        document.querySelectorAll('.tab-content').forEach(function(content) {
            content.classList.toggle('active', content.id === tabName + '-tab');
        });
    }

    // ==================== Sidebar Collapse ====================

    function toggleLeftSidebar() {
        var sidebar = document.getElementById('sidebar-left');
        var btn = sidebar.querySelector('.sidebar-toggle');
        sidebar.classList.toggle('collapsed');
        btn.innerHTML = sidebar.classList.contains('collapsed') ? '&raquo;' : '&laquo;';
        setTimeout(resizeCanvasToFit, 220);
    }

    function toggleRightSidebar() {
        var sidebar = document.getElementById('sidebar-right');
        var btn = document.querySelector('.right-toggle-btn');
        sidebar.classList.toggle('collapsed');
        btn.innerHTML = sidebar.classList.contains('collapsed') ? '&laquo;' : '&raquo;';

        document.body.classList.toggle('right-sidebar-collapsed', sidebar.classList.contains('collapsed'));

        setTimeout(resizeCanvasToFit, 220);
    }

    function resizeCanvasToFit() {
        var container = document.getElementById('canvas-container');
        var canvas = state.canvas;
        if (container && canvas) {
            var rect = container.getBoundingClientRect();
            canvas.setDimensions({ width: rect.width, height: rect.height });
            canvas.renderAll();
        }
    }

    // ==================== Import Dropdown ====================

    function toggleImportDropdown(btn) {
        var menu = document.getElementById('import-dropdown-menu');
        var isOpen = menu.classList.contains('open');

        if (isOpen) {
            closeImportDropdown();
        } else {
            btn.classList.add('open');
            menu.classList.add('open');

            setTimeout(function() {
                document.addEventListener('click', closeImportDropdownOnClickOutside);
            }, 10);
        }
    }

    function closeImportDropdown() {
        var menu = document.getElementById('import-dropdown-menu');
        var btn = document.querySelector('.import-dropdown-btn');
        if (menu) menu.classList.remove('open');
        if (btn) btn.classList.remove('open');
        document.removeEventListener('click', closeImportDropdownOnClickOutside);
    }

    function closeImportDropdownOnClickOutside(e) {
        var wrapper = document.querySelector('.import-dropdown-wrapper');
        if (wrapper && !wrapper.contains(e.target)) {
            closeImportDropdown();
        }
    }

    // ==================== Layer Section Sorting ====================

    function initLayerSectionSorting() {
        var container = document.getElementById('layers-container');
        if (!container) return;

        var sections = container.querySelectorAll('.sortable-layer-section');

        sections.forEach(function(section) {
            var handle = section.querySelector('.drag-handle');
            if (!handle) return;

            handle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                e.stopPropagation();
                draggedSection = section;
                section.classList.add('dragging');

                document.addEventListener('mousemove', onDragMove);
                document.addEventListener('mouseup', onDragEnd);
            });

            section.addEventListener('dragover', function(e) {
                e.preventDefault();
                if (draggedSection && draggedSection !== section) {
                    section.classList.add('drag-over');
                }
            });

            section.addEventListener('dragleave', function() {
                section.classList.remove('drag-over');
            });
        });

        restoreLayerSectionOrder();
    }

    function onDragMove(e) {
        if (!draggedSection) return;

        var container = document.getElementById('layers-container');
        var sections = Array.from(container.querySelectorAll('.sortable-layer-section'));

        var mouseY = e.clientY;
        var targetSection = null;

        for (var i = 0; i < sections.length; i++) {
            if (sections[i] === draggedSection) continue;
            var rect = sections[i].getBoundingClientRect();
            if (mouseY >= rect.top && mouseY <= rect.bottom) {
                targetSection = sections[i];
                break;
            }
        }

        sections.forEach(function(s) { s.classList.remove('drag-over'); });

        if (targetSection) {
            var targetRect = targetSection.getBoundingClientRect();
            var isAboveMiddle = mouseY < targetRect.top + targetRect.height / 2;

            if (isAboveMiddle) {
                targetSection.classList.add('drag-over');
            } else {
                var nextSibling = targetSection.nextElementSibling;
                if (nextSibling && nextSibling.classList.contains('sortable-layer-section')) {
                    nextSibling.classList.add('drag-over');
                }
            }
        }
    }

    function onDragEnd(e) {
        if (!draggedSection) return;

        var container = document.getElementById('layers-container');
        var sections = Array.from(container.querySelectorAll('.sortable-layer-section'));

        var mouseY = e.clientY;
        var targetSection = null;
        var insertBefore = true;

        for (var i = 0; i < sections.length; i++) {
            if (sections[i] === draggedSection) continue;
            var rect = sections[i].getBoundingClientRect();
            if (mouseY >= rect.top && mouseY <= rect.bottom) {
                targetSection = sections[i];
                insertBefore = mouseY < rect.top + rect.height / 2;
                break;
            }
        }

        sections.forEach(function(s) { s.classList.remove('drag-over', 'dragging'); });

        if (targetSection && targetSection !== draggedSection) {
            if (insertBefore) {
                container.insertBefore(draggedSection, targetSection);
            } else {
                container.insertBefore(draggedSection, targetSection.nextSibling);
            }
            saveLayerSectionOrder();
        }

        draggedSection = null;
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
    }

    function saveLayerSectionOrder() {
        var container = document.getElementById('layers-container');
        if (!container) return;

        var sections = container.querySelectorAll('.sortable-layer-section');
        var order = Array.from(sections).map(function(s) { return s.dataset.section; });

        localStorage.setItem('docuweaver-layer-order-' + PROJECT_ID, JSON.stringify(order));
        console.log('Layer section order saved:', order);
    }

    function restoreLayerSectionOrder() {
        var container = document.getElementById('layers-container');
        if (!container) return;

        var savedOrder = localStorage.getItem('docuweaver-layer-order-' + PROJECT_ID);
        if (!savedOrder) return;

        try {
            var order = JSON.parse(savedOrder);
            var sections = container.querySelectorAll('.sortable-layer-section');
            var sectionMap = {};

            sections.forEach(function(s) {
                sectionMap[s.dataset.section] = s;
            });

            order.forEach(function(sectionName) {
                if (sectionMap[sectionName]) {
                    container.appendChild(sectionMap[sectionName]);
                }
            });

            console.log('Layer section order restored:', order);
        } catch (e) {
            console.warn('Failed to restore layer section order:', e);
        }
    }

    function moveMeasurementSectionToTop() {
        var container = document.getElementById('layers-container');
        if (!container) return;

        var measurementSection = container.querySelector('.sortable-layer-section[data-section="measurements"]');
        if (measurementSection && container.firstChild !== measurementSection) {
            container.insertBefore(measurementSection, container.firstChild);
            saveLayerSectionOrder();
        }
    }

    // Initialize layer sorting on DOM ready
    document.addEventListener('DOMContentLoaded', function() {
        initLayerSectionSorting();
    });

    // ==================== Public API ====================

    DW.sidebar = {
        showTab: showTab,
        toggleLeftSidebar: toggleLeftSidebar,
        toggleRightSidebar: toggleRightSidebar,
        resizeCanvasToFit: resizeCanvasToFit,
        toggleImportDropdown: toggleImportDropdown,
        closeImportDropdown: closeImportDropdown,
        initLayerSectionSorting: initLayerSectionSorting,
        saveLayerSectionOrder: saveLayerSectionOrder,
        restoreLayerSectionOrder: restoreLayerSectionOrder,
        moveMeasurementSectionToTop: moveMeasurementSectionToTop
    };

    // Backward compatibility
    window.showTab = showTab;
    window.toggleLeftSidebar = toggleLeftSidebar;
    window.toggleRightSidebar = toggleRightSidebar;
    window.resizeCanvasToFit = resizeCanvasToFit;
    window.toggleImportDropdown = toggleImportDropdown;
    window.closeImportDropdown = closeImportDropdown;
    window.initLayerSectionSorting = initLayerSectionSorting;
    window.saveLayerSectionOrder = saveLayerSectionOrder;
    window.restoreLayerSectionOrder = restoreLayerSectionOrder;
    window.moveMeasurementSectionToTop = moveMeasurementSectionToTop;

    console.log('DocuWeaver sidebar module loaded');
})();
