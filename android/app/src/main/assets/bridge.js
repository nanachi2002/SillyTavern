/*
 * Injected into the SillyTavern page by the Android app (MainActivity).
 *
 * 1. Downloads: WebView can't save <a download> links or blob: URLs on its own. Exports,
 *    backups and other downloads are read in the page and streamed to the native side
 *    (window.SillyTavernAndroid), which saves them to Download/SillyTavern.
 * 2. Back button: closes the topmost popup, editor or panel like Escape would, without
 *    touching an in-progress generation. Returns false when nothing was open.
 */
(function () {
    'use strict';
    if (window.__stAndroid) {
        return;
    }
    const native = window.SillyTavernAndroid;
    if (!native) {
        return;
    }

    // ---- Downloads ------------------------------------------------------------------------
    const blobs = new Map();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    URL.createObjectURL = function (object) {
        const url = originalCreateObjectURL.call(URL, object);
        if (object instanceof Blob) {
            blobs.set(url, object);
        }
        return url;
    };

    // Pages often revoke the URL right after a.click(); keep the blob around long enough to save it.
    URL.revokeObjectURL = function (url) {
        setTimeout(() => {
            blobs.delete(url);
            originalRevokeObjectURL.call(URL, url);
        }, 60000);
    };

    const CHUNK_SIZE = 768 * 1024;

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result);
                resolve(result.substring(result.indexOf(',') + 1));
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    async function getBlob(url) {
        if (blobs.has(url)) {
            return blobs.get(url);
        }
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }
        return await response.blob();
    }

    function fileNameFromUrl(url) {
        try {
            const parsed = new URL(url, location.href);
            const last = parsed.pathname.split('/').filter(Boolean).pop();
            return last ? decodeURIComponent(last) : 'download';
        } catch {
            return 'download';
        }
    }

    async function saveUrl(url, fileName, mimeType) {
        let id = -1;
        try {
            const blob = await getBlob(url);
            id = native.beginDownload(fileName || fileNameFromUrl(url), blob.type || mimeType || '');
            if (id < 0) {
                return;
            }
            for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
                const chunk = await blobToBase64(blob.slice(offset, offset + CHUNK_SIZE));
                if (!native.appendDownload(id, chunk)) {
                    return;
                }
            }
            native.finishDownload(id);
        } catch (error) {
            console.error('[Android] Download failed', error);
            native.failDownload(id, String(error && error.message || error));
        }
    }

    function isSameOrigin(url) {
        try {
            return new URL(url, location.href).origin === location.origin;
        } catch {
            return false;
        }
    }

    function shouldHandle(anchor) {
        if (!anchor || !anchor.hasAttribute('download')) {
            return false;
        }
        const href = anchor.href;
        return !!href && (href.startsWith('blob:') || href.startsWith('data:') || isSameOrigin(href));
    }

    function handleAnchor(anchor) {
        const name = anchor.getAttribute('download') || fileNameFromUrl(anchor.href);
        saveUrl(anchor.href, name, anchor.type || '');
    }

    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (shouldHandle(this)) {
            handleAnchor(this);
            return;
        }
        return originalClick.call(this);
    };

    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('a[download]') : null;
        if (target && shouldHandle(target)) {
            event.preventDefault();
            event.stopPropagation();
            handleAnchor(target);
        }
    }, true);

    // ---- Back button ------------------------------------------------------------------------
    function isVisible(element) {
        return !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    }

    function clickIfVisible(selector) {
        const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (element) {
            element.click();
            return true;
        }
        return false;
    }

    function handleBack() {
        // ST popups are modal <dialog>s; the topmost one is the last in the DOM
        const dialogs = Array.from(document.querySelectorAll('dialog[open]')).filter(isVisible);
        if (dialogs.length) {
            const dialog = dialogs[dialogs.length - 1];
            const cancelEvent = new Event('cancel', { cancelable: true });
            if (dialog.dispatchEvent(cancelEvent)) {
                dialog.close();
            }
            return true;
        }

        // Message editors (cancel, like Escape does)
        const editCancel = Array.from(document.querySelectorAll('.mes_edit_cancel, .mes_reasoning_edit_cancel')).find(isVisible);
        if (editCancel) {
            editCancel.click();
            return true;
        }

        // Legacy popups
        if (isVisible(document.getElementById('dialogue_popup'))) {
            return clickIfVisible('#dialogue_popup_cancel') || clickIfVisible('#dialogue_popup_ok');
        }
        for (const selector of ['#select_chat_cross', '#character_cross', '#dialogue_del_mes_cancel', '#logprobsViewerClose', '#CFGClose', '#ANClose', '.dragClose', '.floating_panel_close']) {
            if (clickIfVisible(selector)) {
                return true;
            }
        }

        // Burger and wand menus
        for (const id of ['options', 'extensionsMenu']) {
            const menu = document.getElementById(id);
            if (isVisible(menu)) {
                window.jQuery ? window.jQuery(menu).hide() : (menu.style.display = 'none');
                return true;
            }
        }

        // Top bar drawers, including the left/right panels unless they are pinned
        const openDrawers = Array.from(document.querySelectorAll('.drawer-content.openDrawer')).filter(isVisible);
        for (const drawer of openDrawers.reverse()) {
            if (drawer.id === 'left-nav-panel' && document.getElementById('lm_button_panel_pin')?.checked) continue;
            if (drawer.id === 'right-nav-panel' && document.getElementById('rm_button_panel_pin')?.checked) continue;
            const icon = drawer.parentElement && drawer.parentElement.querySelector('.drawer-icon');
            if (icon) {
                icon.click();
                return true;
            }
        }

        return false;
    }

    window.__stAndroid = {
        handleBack,
        saveUrl,
    };
})();
