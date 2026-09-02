/**
 * DocuWeaver Canvas Editor - Links Module
 * 
 * Handles link (polyline) layer rendering and management.
 * 
 * Depends on: namespace.js, assets.js (for assetMeterToPixel)
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Link Rendering ====================
    
    function renderLinksOnCanvas() {
        const canvas = state.canvas;
        
        // Remove existing link objects
        const existingLinks = canvas.getObjects().filter(obj => obj.isLinkObject);
        existingLinks.forEach(obj => canvas.remove(obj));

        // Only render links if a reference point has been placed
        if (!state.refAssetId || (state.refPixelX === 0 && state.refPixelY === 0)) {
            return;
        }

        // Only render if links are visible
        if (!state.linksVisible) {
            canvas.renderAll();
            return;
        }

        state.links.forEach(link => {
            // Check if link's group is visible
            if (link.layer_group && state.groupVisibility[link.layer_group] === false) {
                return;
            }

            if (!link.coordinates || link.coordinates.length < 2) {
                return;
            }

            // Convert coordinates to pixel positions
            const points = link.coordinates.map(coord => {
                const pos = assetMeterToPixel(coord[0], coord[1]);
                return { x: pos.x, y: pos.y };
            });

            // Create polyline
            const polyline = new fabric.Polyline(points, {
                fill: 'transparent',
                stroke: link.color || '#0066FF',
                strokeWidth: link.width || 2,
                opacity: link.opacity || 1.0,
                selectable: false,
                evented: false,
                isLinkObject: true,
                linkData: link
            });

            canvas.add(polyline);
        });

        // Position links above sheets and OSM but below assets
        const objects = canvas.getObjects();
        let insertIndex = 0;
        objects.forEach((obj, idx) => {
            if (obj.sheetData || obj.isOSMTile) {
                insertIndex = Math.max(insertIndex, idx + 1);
            }
        });
        
        const linkObjects = objects.filter(obj => obj.isLinkObject);
        linkObjects.forEach(linkObj => {
            canvas.moveTo(linkObj, insertIndex);
        });

        canvas.renderAll();
    }
    
    // ==================== Link Selection ====================
    
    function selectLink(linkId) {
        const canvas = state.canvas;
        
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) obj.shadow = null;
            if (obj.isLinkObject && obj.linkData && obj.linkData.id === linkId) {
                canvas.setActiveObject(obj);
                // Don't center viewport - just select the object
                // User may want to see it in context of current view
            }
        });
        canvas.renderAll();
    }
    
    function highlightLink(link) {
        const canvas = state.canvas;
        const linkObjs = canvas.getObjects().filter(obj => 
            obj.isLinkObject && obj.linkData && obj.linkData.id === link.id
        );
        
        if (linkObjs.length === 0) return;

        const obj = linkObjs[0];
        const originalStroke = obj.stroke;
        const originalWidth = obj.strokeWidth;

        obj.set({ stroke: '#FFD700', strokeWidth: originalWidth + 2 });
        canvas.renderAll();

        setTimeout(() => {
            obj.set({ stroke: originalStroke, strokeWidth: originalWidth });
            canvas.renderAll();
        }, 500);
    }
    
    // ==================== Link Visibility ====================
    
    function toggleLinksVisibility(visible) {
        state.linksVisible = visible;
        window.linksVisible = visible;
        renderLinksOnCanvas();
    }
    
    function toggleLinkVisibility(linkId, visible) {
        const link = state.links.find(l => l.id === linkId);
        if (link) {
            link.visible = visible;
        }
        state.canvas.getObjects().forEach(obj => {
            if (obj.linkData && obj.linkData.id === linkId) {
                obj.visible = visible;
            }
        });
        state.canvas.renderAll();
    }
    
    function clearLinksFromCanvas() {
        const canvas = state.canvas;
        const linkObjs = canvas.getObjects().filter(obj => obj.isLinkObject);
        linkObjs.forEach(obj => canvas.remove(obj));
    }
    
    // ==================== Link List ====================
    
    function renderLinkList() {
        // Links are now rendered inside folders by renderLinkGroupList()
        // This function is kept for backwards compatibility
    }
    
    // ==================== Public API ====================
    
    DW.links = {
        renderLinksOnCanvas,
        selectLink,
        highlightLink,
        toggleLinksVisibility,
        toggleLinkVisibility,
        clearLinksFromCanvas,
        renderLinkList
    };
    
    // Expose globally for backward compatibility
    window.renderLinksOnCanvas = renderLinksOnCanvas;
    window.selectLink = selectLink;
    window.highlightLink = highlightLink;
    window.toggleLinksVisibility = toggleLinksVisibility;
    window.toggleLinkVisibility = toggleLinkVisibility;
    window.clearLinksFromCanvas = clearLinksFromCanvas;
    window.renderLinkList = renderLinkList;
    
    console.log('DocuWeaver links module loaded');
})();
