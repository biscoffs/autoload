// ==UserScript==
// @name         4chan OTK Thread Viewer
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Viewer for OTK tracked threads messages with recursive quoted messages and toggle support
// @match        https://boards.4chan.org/b/
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    console.log('[OTK Viewer EXECUTION] Script starting to execute.');

    let twitterWidgetsLoaded = false;
    let twitterWidgetsLoading = false;
    let embedObserver = null;
    let isFirstRunAfterPageLoad = true;

    let originalBodyOverflow = '';
    let otherBodyNodes = [];

    // ---> START OF MOVED BLOCK <---
    const DB_NAME = 'OTKMediaCacheDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'mediaFilesStore';
    let dbPromise = null;

    function openDB() {
        if (dbPromise) {
            return dbPromise; // Return existing promise if already connecting/connected
        }
        dbPromise = new Promise((resolve, reject) => {
            console.log('[OTK Cache] Opening IndexedDB: ' + DB_NAME + ' version ' + DB_VERSION);
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                console.log('[OTK Cache] onupgradeneeded: Upgrading/creating database.');
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                    console.log('[OTK Cache] Created object store: ' + STORE_NAME);
                    store.createIndex('timestampIdx', 'timestamp', { unique: false });
                    console.log('[OTK Cache] Created index: timestampIdx');
                }
            };

            request.onsuccess = (event) => {
                console.log('[OTK Cache] Database opened successfully.');
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                console.error('[OTK Cache] Error opening database:', event.target.error);
                dbPromise = null; // Reset promise on error so next call can try again
                reject(event.target.error);
            };

            request.onblocked = (event) => {
                console.warn('[OTK Cache] Database open request blocked. Please close other tabs using this database.', event);
                dbPromise = null; // Reset
                reject(new Error('IndexedDB open request blocked.'));
            };
        });
        return dbPromise;
    }

    async function getMedia(url) {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite'); // readwrite to update timestamp
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(url);

                request.onsuccess = (event) => {
                    const record = event.target.result;
                    if (record) {
                        console.log('[OTK Cache] getMedia: Found record for URL:', url);
                        // Update timestamp for LRU (Least Recently Used)
                        record.timestamp = Date.now();
                        const updateRequest = store.put(record);
                        updateRequest.onerror = (updErr) => {
                            console.error('[OTK Cache] getMedia: Error updating timestamp for URL:', url, updErr.target.error);
                            // Still resolve with the record, timestamp update is best-effort
                            resolve(record.blob);
                        };
                        updateRequest.onsuccess = () => {
                            console.log('[OTK Cache] getMedia: Timestamp updated for URL:', url);
                            resolve(record.blob);
                        };
                    } else {
                        console.log('[OTK Cache] getMedia: No record found for URL:', url);
                        resolve(null);
                    }
                };
                request.onerror = (event) => {
                    console.error('[OTK Cache] getMedia: Error getting record for URL:', url, event.target.error);
                    reject(event.target.error);
                };
                transaction.oncomplete = () => {
                    // console.log('[OTK Cache] getMedia: Transaction completed for URL:', url);
                };
                transaction.onerror = (event) => {
                    console.error('[OTK Cache] getMedia: Transaction error for URL:', url, event.target.error);
                    reject(event.target.error); // This might reject before request.onerror if transaction itself fails
                };
            });
        } catch (dbOpenError) {
            console.error('[OTK Cache] getMedia: Failed to open DB, cannot get media for URL:', url, dbOpenError);
            return null; // Or reject(dbOpenError)
        }
    }

    async function saveMedia(url, blob, filename = '', originalExt = '') {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                if (!blob || blob.size === 0) {
                    console.warn('[OTK Cache] saveMedia: Blob is null or empty for URL:', url, '. Skipping save.');
                    return reject(new Error('Cannot save null or empty blob.'));
                }

                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const mediaType = blob.type.startsWith('image/') ? 'image' : (blob.type.startsWith('video/') ? 'video' : 'other');

                const record = {
                    url: url,
                    blob: blob,
                    timestamp: Date.now(),
                    filename: filename,
                    originalExt: originalExt,
                    mediaType: mediaType,
                    size: blob.size
                };

                const request = store.put(record);

                request.onsuccess = () => {
                    console.log('[OTK Cache] saveMedia: Successfully saved/updated media for URL:', url, '(Size: ' + blob.size + ')');
                    resolve(true);
                };
                request.onerror = (event) => {
                    console.error('[OTK Cache] saveMedia: Error saving media for URL:', url, event.target.error);
                    if (event.target.error.name === 'QuotaExceededError') {
                        console.warn('[OTK Cache] QuotaExceededError! Need to implement cache eviction.');
                        // TODO: Implement cache eviction strategy here or trigger it.
                    }
                    reject(event.target.error);
                };
                 transaction.oncomplete = () => {
                    // console.log('[OTK Cache] saveMedia: Transaction completed for URL:', url);
                };
                transaction.onerror = (event) => {
                    console.error('[OTK Cache] saveMedia: Transaction error for URL:', url, event.target.error);
                    reject(event.target.error);
                };
            });
        } catch (dbOpenError) {
            console.error('[OTK Cache] saveMedia: Failed to open DB, cannot save media for URL:', url, dbOpenError);
            return false; // Or reject(dbOpenError)
        }
    }
    // ---> END OF MOVED BLOCK <---

    // Storage keys (must match tracker script)
    const THREADS_KEY = 'otkActiveThreads';
    const MESSAGES_KEY = 'otkMessagesByThreadId';
    const COLORS_KEY = 'otkThreadColors';
    const SELECTED_MESSAGE_KEY = 'otkSelectedMessageId';

    // Decode HTML entities utility
    function decodeEntities(encodedString) {
        const txt = document.createElement('textarea');
        txt.innerHTML = encodedString;
        return txt.value;
    }

    function handleIntersection(entries, observer) {
        entries.forEach(entry => {
            const placeholder = entry.target;
            const isLoaded = placeholder.dataset.loaded === 'true';

            if (entry.isIntersecting) {
                if (!isLoaded) {
                    // Load iframe or direct video
                    const embedType = placeholder.dataset.embedType;
                    const videoId = placeholder.dataset.videoId;
                    const startTime = placeholder.dataset.startTime; // Will be undefined if not set

                    console.log(`[OTK Viewer IO] Loading embed for: ${embedType} - ${videoId}`);

                    if (embedType === 'streamable') {
                        const guessedMp4Url = `https://cf-files.streamable.com/temp/${videoId}.mp4`;
                        placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Checking cache...</div>'; // Temporary loading indicator
                        placeholder.style.backgroundColor = '#2c2c2c'; // Ensure loading bg

                        getMedia(guessedMp4Url).then(cachedBlob => {
                            if (cachedBlob) {
                                const objectURL = URL.createObjectURL(cachedBlob);
                                placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable');
                                placeholder.dataset.loaded = 'true';
                                placeholder.dataset.cached = 'true';
                                console.log(`[OTK Cache IO] Loaded Streamable ${videoId} from cache.`);
                                placeholder.style.height = 'auto';
                                placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio for video
                                placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                            } else {
                                placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Fetching video...</div>'; // Update loading indicator
                                fetch(guessedMp4Url)
                                    .then(response => {
                                        if (response.ok && response.headers.get('content-type')?.startsWith('video/')) {
                                            return response.blob();
                                        }
                                        throw new Error('Streamable direct MP4 fetch failed or not a video. Status: ' + response.status + ' URL: ' + guessedMp4Url);
                                    })
                                    .then(blob => {
                                        saveMedia(guessedMp4Url, blob, videoId + '.mp4', '.mp4');
                                        const objectURL = URL.createObjectURL(blob);
                                        placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable');
                                        placeholder.dataset.loaded = 'true';
                                        placeholder.dataset.cached = 'true'; // Mark as cached even if fetched now
                                        console.log(`[OTK Cache IO] Fetched, cached, and loaded Streamable ${videoId}.`);
                                        placeholder.style.height = 'auto';
                                        placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                                        placeholder.style.backgroundColor = 'transparent';
                                    })
                                    .catch(err => {
                                        console.warn(`[OTK Cache IO] Streamable direct MP4 for ${videoId} failed: ${err.message}. Falling back to iframe.`);
                                        placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                                        placeholder.dataset.loaded = 'true';
                                        placeholder.style.height = '360px'; // Fallback fixed height for iframe
                                        placeholder.style.aspectRatio = '';
                                        placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                                    });
                            }
                        }).catch(dbError => {
                            console.error(`[OTK Cache IO] IndexedDB error for Streamable ${videoId}: ${dbError.message}. Falling back to iframe.`);
                            placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                            placeholder.dataset.loaded = 'true';
                            placeholder.style.height = '360px'; // Fallback fixed height
                            placeholder.style.aspectRatio = '';
                            placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                        });
                    } else if (embedType === 'youtube') {
                        const iframeHTML = getYouTubeIframeHTML(videoId, startTime ? parseInt(startTime, 10) : null);
                        placeholder.style.height = '';
                        placeholder.style.aspectRatio = '16 / 9';
                        // console.log(`[OTK Viewer IO] Ensured placeholder aspect-ratio 16/9 for ${embedType}: ${videoId}`);
                         if (iframeHTML) {
                            placeholder.innerHTML = iframeHTML;
                            placeholder.dataset.loaded = 'true';
                        }
                    } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                        const iframeHTML = getTwitchIframeHTML(embedType === 'twitch-clip' ? 'clip' : 'video', videoId, startTime ? parseInt(startTime, 10) : null);
                        placeholder.style.height = '360px'; // Twitch iframes often need this
                        placeholder.style.aspectRatio = '';
                        // console.log(`[OTK Viewer IO] Set placeholder height to 360px for ${embedType}: ${videoId}`);
                         if (iframeHTML) {
                            placeholder.innerHTML = iframeHTML;
                            placeholder.dataset.loaded = 'true';
                        }
                    }
                    // The original common `if (iframeHTML)` block is removed as logic is now per-case.
                }
            } else {
                // Unload iframe (element is out of view)
                if (isLoaded) {
                    console.log(`[OTK Viewer IO] Unloading embed for: ${placeholder.dataset.embedType} - ${placeholder.dataset.videoId}`);
                    const embedType = placeholder.dataset.embedType;
                    const videoId = placeholder.dataset.videoId;
                    let innerPlaceholderHTML = '<div class="play-button-overlay">▶</div>';
                    let specificClass = '';
                    let specificText = '';

                    // Restore visual cues for specific services
                    if (embedType === 'youtube') {
                        placeholder.style.backgroundImage = `url('https://i.ytimg.com/vi/${videoId}/mqdefault.jpg')`;
                        specificClass = 'youtube-placeholder';
                    } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                        placeholder.style.backgroundImage = ''; // Clear any previous
                        specificClass = 'twitch-placeholder';
                        specificText = embedType === 'twitch-clip' ? 'Twitch Clip' : 'Twitch VOD';
                        innerPlaceholderHTML += `<span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">${specificText}</span>`;
                    } else if (embedType === 'streamable') {
                        placeholder.style.backgroundImage = '';
                        specificClass = 'streamable-placeholder';
                        specificText = 'Streamable Video';
                        innerPlaceholderHTML += `<span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">${specificText}</span>`;
                    }

                    // ---> ADD NEW LOGIC BELOW <---
                    placeholder.style.height = ''; // Reset fixed height
                    placeholder.style.aspectRatio = '16 / 9'; // Reset to default CSS aspect ratio
                    console.log(`[OTK Viewer IO] Reset placeholder style for ${embedType}: ${videoId} before unloading.`);
                    // ---> ADD NEW LOGIC ABOVE <---

                    placeholder.innerHTML = innerPlaceholderHTML; // Existing line
                    placeholder.dataset.loaded = 'false'; // Existing line
                    // Ensure correct placeholder class is there if it got removed (it shouldn't if we only change innerHTML)
                    if (specificClass && !placeholder.classList.contains(specificClass)) {
                        placeholder.classList.add(specificClass);
                    }
                }
            }
        });
    }

    function handlePlaceholderInteraction(event) {
        // Find the placeholder element, whether event target is placeholder or its child (like the play button text span)
        const placeholder = event.target.closest('.embed-placeholder');

        if (!placeholder || placeholder.dataset.loaded === 'true') {
            return; // Not a placeholder or already loaded
        }

        // Check for correct event type and key for keydown
        if (event.type === 'click' || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' '))) {
            if (event.type === 'keydown') {
                event.preventDefault(); // Prevent space from scrolling, enter from submitting form etc.
            }

            // Same loading logic as in IntersectionObserver's intersecting branch
            const embedType = placeholder.dataset.embedType;
            const videoId = placeholder.dataset.videoId;
            const startTime = placeholder.dataset.startTime;
            // let iframeHTML = ''; // iframeHTML will be handled per-case now
            console.log('[OTK Viewer UX] handlePlaceholderInteraction: Processing event for embedType: ' + embedType + ', videoId: ' + videoId + ', eventType: ' + event.type);
            console.log(`[OTK Viewer UX] Manually triggering load for: ${embedType} - ${videoId}`);

            if (embedType === 'streamable') {
                const guessedMp4Url = `https://cf-files.streamable.com/temp/${videoId}.mp4`;
                placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Checking cache...</div>'; // Temp loading indicator
                placeholder.style.backgroundColor = '#2c2c2c'; // Ensure loading bg

                getMedia(guessedMp4Url).then(cachedBlob => {
                    if (cachedBlob) {
                        const objectURL = URL.createObjectURL(cachedBlob);
                        placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable');
                        placeholder.dataset.loaded = 'true';
                        placeholder.dataset.cached = 'true';
                        console.log(`[OTK Cache UX] Loaded Streamable ${videoId} from cache.`);
                        placeholder.style.height = 'auto';
                        placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                        placeholder.style.backgroundColor = 'transparent'; // Clear loading bg
                    } else {
                        placeholder.innerHTML = '<div class="play-button-overlay" style="color: #ccc;">▶ Fetching video...</div>';
                        fetch(guessedMp4Url)
                            .then(response => {
                                if (response.ok && response.headers.get('content-type')?.startsWith('video/')) {
                                    return response.blob();
                                }
                                throw new Error('Streamable direct MP4 fetch failed or not a video. Status: ' + response.status + ' URL: ' + guessedMp4Url);
                            })
                            .then(blob => {
                                saveMedia(guessedMp4Url, blob, videoId + '.mp4', '.mp4');
                                const objectURL = URL.createObjectURL(blob);
                                placeholder.innerHTML = createVideoElementHTML(objectURL, videoId, 'streamable');
                                placeholder.dataset.loaded = 'true';
                                placeholder.dataset.cached = 'true'; // Mark as cached even if fetched now
                                console.log(`[OTK Cache UX] Fetched, cached, and loaded Streamable ${videoId}.`);
                                placeholder.style.height = 'auto';
                                placeholder.style.aspectRatio = '16 / 9'; // Keep aspect ratio
                                placeholder.style.backgroundColor = 'transparent';
                            })
                            .catch(err => {
                                console.warn(`[OTK Cache UX] Streamable direct MP4 for ${videoId} failed: ${err.message}. Falling back to iframe.`);
                                placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                                placeholder.dataset.loaded = 'true';
                                placeholder.style.height = '360px'; // Fallback fixed height
                                placeholder.style.aspectRatio = '';
                                placeholder.style.backgroundColor = 'transparent';
                            });
                    }
                }).catch(dbError => {
                    console.error(`[OTK Cache UX] IndexedDB error for Streamable ${videoId}: ${dbError.message}. Falling back to iframe.`);
                    placeholder.innerHTML = getStreamableIframeHTML(videoId); // Fallback
                    placeholder.dataset.loaded = 'true';
                    placeholder.style.height = '360px'; // Fallback fixed height
                    placeholder.style.aspectRatio = '';
                    placeholder.style.backgroundColor = 'transparent';
                });
                event.stopPropagation(); // Stop propagation for Streamable as it's handled
                // console.log('[OTK Viewer UX] Stopped event propagation after manual load attempt for ' + embedType + ': ' + videoId);
            } else if (embedType === 'youtube') {
                const iframeHTML = getYouTubeIframeHTML(videoId, startTime ? parseInt(startTime, 10) : null);
                placeholder.style.height = '';
                placeholder.style.aspectRatio = '16 / 9';
                // console.log(`[OTK Viewer UX] Ensured placeholder aspect-ratio 16/9 for manually loaded ${embedType}: ${videoId}`);
                if (iframeHTML) {
                    placeholder.innerHTML = iframeHTML;
                    placeholder.dataset.loaded = 'true';
                    event.stopPropagation();
                    // console.log('[OTK Viewer UX] Stopped event propagation after manual load for ' + embedType + ': ' + videoId);
                }
            } else if (embedType === 'twitch-clip' || embedType === 'twitch-vod') {
                const iframeHTML = getTwitchIframeHTML(embedType === 'twitch-clip' ? 'clip' : 'video', videoId, startTime ? parseInt(startTime, 10) : null);
                placeholder.style.height = '360px'; // Twitch iframes often need this
                placeholder.style.aspectRatio = '';
                // console.log(`[OTK Viewer UX] Set placeholder height to 360px for manually loaded ${embedType}: ${videoId}`);
                if (iframeHTML) {
                    placeholder.innerHTML = iframeHTML;
                    placeholder.dataset.loaded = 'true';
                    event.stopPropagation();
                    // console.log('[OTK Viewer UX] Stopped event propagation after manual load for ' + embedType + ': ' + videoId);
                }
            }
            // The original common `if (iframeHTML)` block is removed as logic is now per-case.
        }
    }

    function ensureTwitterWidgetsLoaded() {
        return new Promise((resolve, reject) => {
            if (twitterWidgetsLoaded && window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                resolve();
                return;
            }
            // If already loading, set up a poller
            if (twitterWidgetsLoading) {
                let attempts = 0;
                const interval = setInterval(() => {
                    attempts++;
                    if (twitterWidgetsLoaded && window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                        clearInterval(interval);
                        resolve();
                    } else if (attempts > 60) { // Timeout after ~6 seconds (60 * 100ms)
                        clearInterval(interval);
                        reject(new Error('Timeout waiting for Twitter widgets.js to load after initiation.'));
                    }
                }, 100);
                return;
            }

            twitterWidgetsLoading = true;
            const script = document.createElement('script');
            script.id = 'twitter-widgets-script';
            script.src = 'https://platform.twitter.com/widgets.js';
            script.async = true;
            script.charset = 'utf-8';
            script.onload = () => {
                twitterWidgetsLoaded = true;
                twitterWidgetsLoading = false;
                if (window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                    // Add a small delay for widgets.js to fully initialize after script load event
                    setTimeout(resolve, 100);
                } else {
                     // This case might happen if the script loads but the twttr object isn't as expected immediately.
                    // The polling mechanism for 'twitterWidgetsLoading' should catch it if it initializes shortly after.
                    console.warn('Twitter widgets.js loaded but twttr.widgets.createTweet not immediately found. Will rely on polling if initiated by another call.');
                    // To be safe, reject if it's not found after a brief moment.
                    setTimeout(() => {
                        if (window.twttr && typeof window.twttr.widgets === 'object' && typeof window.twttr.widgets.createTweet === 'function') {
                            resolve();
                        } else {
                            reject(new Error('Twitter widgets.js loaded but twttr.widgets.createTweet not found after delay.'));
                        }
                    }, 500);
                }
            };
            script.onerror = () => {
                twitterWidgetsLoading = false;
                reject(new Error('Failed to load Twitter widgets.js script.'));
            };
            document.head.appendChild(script);
        });
    }

    function createTweetWithTimeout(tweetId, placeholderElement, options, timeoutMs = 20000) { // Default 20s timeout
        return new Promise((resolve, reject) => {
            let timeoutHandle = setTimeout(() => {
                console.warn('[OTK Viewer Tweets] createTweetWithTimeout: Timeout for Tweet ID ' + tweetId + ' after ' + timeoutMs + 'ms');
                reject(new Error('Tweet load timeout for ID ' + tweetId));
            }, timeoutMs);

            window.twttr.widgets.createTweet(tweetId, placeholderElement, options)
                .then(el => {
                    clearTimeout(timeoutHandle);
                    resolve(el);
                })
                .catch(err => {
                    clearTimeout(timeoutHandle);
                    reject(err); // Pass through the original error from createTweet
                });
        });
    }

    async function processTweetEmbeds(containerElement) {
        const placeholders = Array.from(containerElement.querySelectorAll('.twitter-embed-placeholder'));
        console.log(`[OTK Viewer Metrics] processTweetEmbeds: Found ${placeholders.length} Twitter embed placeholders to process.`);
        if (placeholders.length === 0) {
            return;
        }

        try {
            await ensureTwitterWidgetsLoaded();

            const tweetPromises = []; // Array to hold all tweet creation promises

            console.log('[OTK Viewer Tweets] Starting loop to create tweet processing promises for ' + placeholders.length + ' placeholders...');
            for (const placeholder of placeholders) {
                if (placeholder.dataset.processed === 'true') {
                    continue;
                }
                placeholder.dataset.processed = 'true';
                const tweetId = placeholder.dataset.tweetId;

                if (tweetId) {
                    placeholder.innerHTML = 'Loading Tweet...'; // Indicate loading
                    placeholder.style.display = 'flex';
                    placeholder.style.alignItems = 'center';
                    placeholder.style.justifyContent = 'center';

                    tweetPromises.push(
                        createTweetWithTimeout(tweetId, placeholder, {
                            theme: 'light',
                            conversation: 'none',
                            align: 'center',
                            width: 500,
                            dnt: true
                        }, 20000) // Pass timeout, e.g., 20000ms = 20 seconds
                            .then(el => {
                                if (!el) {
                                    console.warn('[OTK Viewer Tweets] Failed to embed Tweet ID: ' + tweetId + '. Twitter function returned no element (after createTweetWithTimeout).');
                                    const originalUrl = placeholder.dataset.originalUrl || 'https://twitter.com/anyuser/status/' + tweetId;
                                    const displayText = 'View Tweet ' + tweetId + ' (Embed failed)';
                                    placeholder.innerHTML = '<a href="' + originalUrl + '" target="_blank" rel="noopener noreferrer">' + displayText + '</a>';
                                    placeholder.style.display = 'block';
                                } else {
                                    placeholder.style.minHeight = '';
                                    placeholder.style.backgroundColor = '';
                                    placeholder.style.display = '';
                                    placeholder.style.alignItems = '';
                                    placeholder.style.justifyContent = '';
                                    console.log('[OTK Viewer Tweets] Successfully embedded Tweet ID: ' + tweetId + ' (via createTweetWithTimeout).');
                                }
                            })
                            .catch(renderError => {
                                console.error('[OTK Viewer Tweets] Error or Timeout rendering Tweet ID ' + tweetId + ':', renderError.message); // Log error message
                                const originalUrl = placeholder.dataset.originalUrl || 'https://twitter.com/anyuser/status/' + tweetId;
                                let errorText = '(Error loading embed)';
                                if (renderError.message && renderError.message.includes('Tweet load timeout')) {
                                    errorText = '(Embed timed out)';
                                }
                                const displayText = 'View Tweet ' + tweetId + ' ' + errorText;
                                placeholder.innerHTML = '<a href="' + originalUrl + '" target="_blank" rel="noopener noreferrer">' + displayText + '</a>';
                                placeholder.style.display = 'block';
                            })
                    );
                    console.log('[OTK Viewer Tweets] Pushed promise (with timeout) for Tweet ID ' + tweetId + '. Total promises now: ' + tweetPromises.length);
                }
            }

            console.log('[OTK Viewer Tweets] Finished creating all tweet promises. Now awaiting Promise.allSettled for ' + tweetPromises.length + ' promises.');
            await Promise.allSettled(tweetPromises);
            console.log('[OTK Viewer LIFECYCLE] processTweetEmbeds: All createTweet promises have settled.');

        } catch (loadError) {
            console.error("Failed to load Twitter widgets or process embeds:", loadError);
            placeholders.forEach(placeholder => {
                // Ensure it's a placeholder that might have been cleared or attempted
                if (placeholder.classList.contains('twitter-embed-placeholder')) {
                    const tweetId = placeholder.dataset.tweetId;
                    const originalEscapedUrl = placeholder.dataset.originalUrl;
                    let displayText = `View Tweet (ID: ${tweetId})`;

                    if (originalEscapedUrl) {
                        const urlMatch = originalEscapedUrl.match(/twitter\.com\/([a-zA-Z0-9_]+)\/status/);
                        if (urlMatch && urlMatch[1]) {
                            displayText = `View Tweet by @${urlMatch[1]} (ID: ${tweetId})`;
                        }
                        placeholder.innerHTML = `<a href="${originalEscapedUrl}" target="_blank" rel="noopener noreferrer" style="color: #1da1f2; text-decoration: none;">${displayText} 🐦 (Embed blocked by client/network)</a>`;
                    } else {
                        const fallbackUrl = `https://twitter.com/anyuser/status/${tweetId}`; // Should ideally not happen
                        placeholder.innerHTML = `<a href="${fallbackUrl}" target="_blank" rel="noopener noreferrer" style="color: #1da1f2; text-decoration: none;">${displayText} 🐦 (Embed blocked, original URL missing)</a>`;
                    }
                    // Reset styling from 'Loading...' state
                    placeholder.style.display = 'block';
                    placeholder.style.alignItems = '';
                    placeholder.style.justifyContent = '';
                }
            });
        }
    }

    // Helper function to create YouTube embed HTML
    function getYouTubeIframeHTML(videoId, startTimeSeconds) {
        let finalSrc = `https://www.youtube.com/embed/${videoId}`;
        if (startTimeSeconds && startTimeSeconds > 0) {
            finalSrc += `?start=${startTimeSeconds}`;
        }
        const iframeHtml = `<iframe width="560" height="315" src="${finalSrc}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="aspect-ratio: 16 / 9; width: 100%; max-width: 560px;"></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

    function createTwitterEmbedPlaceholder(tweetId, originalUrl) {
        const placeholderId = `tweet-embed-placeholder-${tweetId}-${Math.random().toString(36).substring(2, 9)}`;
        let displayText = `View Tweet (ID: ${tweetId})`;
        const urlMatch = originalUrl.match(/twitter\.com\/([a-zA-Z0-9_]+)\/status/);
        if (urlMatch && urlMatch[1]) {
            displayText = `View Tweet by @${urlMatch[1]} (ID: ${tweetId})`;
        }
        const escapedUrl = originalUrl.replace(/"/g, '&quot;');

        // This div will be targeted by twttr.widgets.createTweet
        // It contains a fallback link in case embedding fails or JS is disabled.
        return `<div class="twitter-embed-placeholder" data-tweet-id="${tweetId}" id="${placeholderId}" data-original-url="${escapedUrl}" style="border: 1px solid #ddd; padding: 10px 15px; min-height: 100px; background-color: #f9f9f9; border-radius: 5px; margin: 5px 0;">` +
               `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="color: #1da1f2; text-decoration: none;">${displayText} 🐦 (Loading Tweet...)</a>` +
               `</div>`;
    }

    // Helper function to create Rumble link HTML (updated from embed)
    function createRumbleEmbed(rumbleIdWithV, originalUrl) {
        let displayText;
        // Try to get a more descriptive title from the path part of the URL
        const urlPathMatch = originalUrl.match(/rumble\.com\/(?:v[a-zA-Z0-9]+-)?([a-zA-Z0-9_-]+)(?:\.html|$|\?)/);
        if (urlPathMatch && urlPathMatch[1] && urlPathMatch[1].toLowerCase() !== 'embed') {
            // Capitalize first letter and replace hyphens/underscores with spaces
            let titleCandidate = urlPathMatch[1].replace(/[-_]/g, ' ');
            titleCandidate = titleCandidate.charAt(0).toUpperCase() + titleCandidate.slice(1);
            displayText = `View on Rumble: ${titleCandidate}`;
        } else {
            // Fallback display text if path parsing doesn't yield a good title
            displayText = `View on Rumble (Clip ID: ${rumbleIdWithV})`;
        }
        const escapedUrl = originalUrl.replace(/"/g, '&quot;');
        return `<a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" style="display: block; padding: 10px; border: 1px solid #ccc; border-radius: 10px; text-decoration: none; color: #85c742; background-color: #f0f0f0;">${displayText} <img src="https://rumble.com/favicon.ico" style="width:16px; height:16px; vertical-align:middle; border:none;"></a>`;
    }

    // Helper function to format seconds to Twitch's hms time format
    function formatSecondsToTwitchTime(totalSeconds) {
        if (totalSeconds === null || totalSeconds === undefined || totalSeconds <= 0) {
            return null;
        }
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60); // Ensure seconds is integer
        return `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
    }

    // Helper function to create Twitch embed HTML
    function getTwitchIframeHTML(type, id, startTimeSeconds) { // Added startTimeSeconds
        const parentHostname = 'boards.4chan.org';
        let src = '';
        if (type === 'clip') {
            src = `https://clips.twitch.tv/embed?clip=${id}&parent=${parentHostname}&autoplay=false`;
        } else if (type === 'video') {
            src = `https://player.twitch.tv/?video=${id}&parent=${parentHostname}&autoplay=false`;
            const formattedTime = formatSecondsToTwitchTime(startTimeSeconds);
            if (formattedTime) {
                src += `&t=${formattedTime}`;
            }
        }
        const iframeHtml = `<iframe src="${src}" style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none;" allowfullscreen scrolling="no"></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

    // Helper function to create Streamable embed HTML
    function getStreamableIframeHTML(videoId) {
        const iframeHtml = `<iframe src="https://streamable.com/e/${videoId}?loop=false" style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none;" allowfullscreen></iframe>`;
        return `<div style="display: block; margin-top: 5px; margin-bottom: 5px;">${iframeHtml}</div>`;
    }

function createVideoElementHTML(blobUrl, videoId, type) { // type can be 'streamable', 'twitch-clip' etc. for logging
    const loopAttribute = (type === 'streamable') ? 'loop="false"' : ''; // Add loop="false" for streamable
    console.log(`[OTK Cache] Creating direct video element for ${type} ID ${videoId} with blob URL.`);
    return `<video src="${blobUrl}" controls autoplay="false" ${loopAttribute} style="width: 100%; min-height: 360px; aspect-ratio: 16 / 9; max-width: 640px; border: none; margin: 8px 0; display: block; background-color: #000;"></video>`; // Added background-color
}

    // Helper functions for YouTube time parsing
    function parseTimeParam(timeString) {
        if (!timeString) return null;
        let totalSeconds = 0;
        if (/^\d+$/.test(timeString)) {
            totalSeconds = parseInt(timeString, 10);
        } else {
            const hoursMatch = timeString.match(/(\d+)h/);
            if (hoursMatch) totalSeconds += parseInt(hoursMatch[1], 10) * 3600;
            const minutesMatch = timeString.match(/(\d+)m/);
            if (minutesMatch) totalSeconds += parseInt(minutesMatch[1], 10) * 60;
            const secondsMatch = timeString.match(/(\d+)s/);
            if (secondsMatch) totalSeconds += parseInt(secondsMatch[1], 10);
        }
        return totalSeconds > 0 ? totalSeconds : null;
    }

    function getTimeFromParams(allParamsString) {
        if (!allParamsString) return null;
        // Matches t=VALUE or start=VALUE from the param string
        const timeMatch = allParamsString.match(/[?&](?:t|start)=([^&]+)/);
        if (timeMatch && timeMatch[1]) {
            return parseTimeParam(timeMatch[1]);
        }
        return null;
    }

   function debounce(func, delay) {
       let timeout;
       return function(...args) {
           const context = this;
           clearTimeout(timeout);
           timeout = setTimeout(() => func.apply(context, args), delay);
       };
   }

   async function scrollToMessageById(messageId, blockAlign = 'center', isExplicitSelection = false) {
       const MAX_RETRIES = 5; // Max number of attempts to find the element
       const RETRY_DELAY_MS = 750; // Delay between retry attempts

       for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
           const element = viewer.querySelector('div[data-message-id="' + messageId + '"]');
           if (element) {
               if (isExplicitSelection) {
                   const previouslySelected = viewer.querySelector('.selected-message');
                   if (previouslySelected && previouslySelected !== element) { // Avoid removing class from element itself if re-selecting
                       previouslySelected.classList.remove('selected-message');
                   }
                   element.classList.add('selected-message');
               }
               console.log('[OTK Viewer Scroll] scrollToMessageById: Found element for ID ' + messageId + ' on attempt ' + attempt + '. Will scroll with align: ' + blockAlign + '.');

               // The actual scroll is still delayed slightly after finding
               setTimeout(() => {
                   console.log('[OTK Viewer Scroll] scrollToMessageById: Scrolling to element for ID ' + messageId + ' after action delay.');
                   element.scrollIntoView({ behavior: 'auto', block: blockAlign });
               }, 250); // Keep this short delay for the scroll action itself
               return true; // Element found, scroll initiated (or will be shortly)
           } else {
               console.log('[OTK Viewer Scroll] scrollToMessageById: Element NOT FOUND for ID ' + messageId + ' on attempt ' + attempt + '/' + MAX_RETRIES + '.');
               if (attempt < MAX_RETRIES) {
                   console.log('[OTK Viewer Scroll] Retrying find for ID ' + messageId + ' in ' + RETRY_DELAY_MS + 'ms...');
                   await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
               }
           }
       }

    // This log line below was the original final log before 'return false'
    // console.log(`[OTK Viewer Scroll] scrollToMessageById: Element NOT FOUND for ID \${messageId} after all \${MAX_RETRIES} attempts.`);
    // We'll make it part of the new diagnostic block for clarity.

    // New diagnostic block:
    console.log('[OTK Viewer Diagnostics] scrollToMessageById: FINAL FAILURE to find ID ' + messageId + ' after ' + MAX_RETRIES + ' attempts.');
    if (viewer) { // Check if viewer itself exists
        console.log('    - viewer.isConnected: ' + viewer.isConnected);
        console.log('    - viewer.children.length (direct children): ' + viewer.children.length);
        const currentMessagesInDOM = viewer.querySelectorAll('div[data-message-id]');
        console.log('    - found elements with data-message-id: ' + currentMessagesInDOM.length);

        if (currentMessagesInDOM.length === 0 && viewer.children.length > 0) {
            // If no data-message-id divs found but viewer has children, log snippet
            console.log('    - viewer.innerHTML snippet (start): ' + viewer.innerHTML.substring(0, 2000));
            console.log('    - viewer.innerHTML snippet (end): ' + viewer.innerHTML.substring(Math.max(0, viewer.innerHTML.length - 2000)));
        } else if (currentMessagesInDOM.length > 0 && currentMessagesInDOM.length < 15) {
            // If some messages are found but not many, log their IDs
            let ids = [];
            currentMessagesInDOM.forEach(el => ids.push(el.dataset.messageId));
            console.log('    - IDs found in DOM: [' + ids.join(', ') + ']');
            // Check if the target ID is among them but perhaps under a different query
            if (!ids.includes(messageId)) {
                 console.log('    - Target ID ' + messageId + ' is NOT among these found IDs.');
            }
        } else if (currentMessagesInDOM.length === 0 && viewer.children.length === 0) {
            console.log('    - viewer appears to be completely empty.');
        }
    } else {
        console.log('    - CRITICAL: viewer element itself is null or undefined at this point!');
    }

       return false; // Element not found after all retries
   }

   async function manageInitialScroll() {
    if (isFirstRunAfterPageLoad) {
        console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: First run after page load. Proceeding with scroll logic normally for this test. Flag is_first_run will be cleared.');
        isFirstRunAfterPageLoad = false; // Clear the flag
    }
       console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: Entered');
       const explicitSelectionId = localStorage.getItem(SELECTED_MESSAGE_KEY);
       if (explicitSelectionId) {
           console.log('[OTK Viewer Scroll] manageInitialScroll: Attempting to restore explicit selection:', explicitSelectionId);
           if (await scrollToMessageById(explicitSelectionId, 'center', true)) { // Pass true for isExplicitSelection
               return; // Explicit selection found and scrolled to
           }
       }

       const lastScrolledId = sessionStorage.getItem('otkLastScrolledMessageId');
       if (lastScrolledId) {
           console.log('[OTK Viewer Scroll] manageInitialScroll: Attempting to restore last scrolled position:', lastScrolledId);
           if (await scrollToMessageById(lastScrolledId, 'start', false)) { // isExplicitSelection is false
               return; // Last scrolled position found and scrolled to
           }
           // If not found (e.g. message got pruned from view), clear it so we go to newest next time
           sessionStorage.removeItem('otkLastScrolledMessageId');
           console.log('[OTK Viewer Scroll] manageInitialScroll: Removed missing lastScrolledId:', lastScrolledId);
       }

       // Fallback: Scroll to most recent message
       console.log('[OTK Viewer Scroll] manageInitialScroll: No selection or last scroll found, scrolling to newest message.');
       if (viewer.children.length > 0) {
           const lastMessageElement = viewer.lastElementChild;
           if (lastMessageElement) {
               setTimeout(() => { // Keep existing delay
                   console.log('[OTK Viewer Scroll] manageInitialScroll: Scrolling to last message after delay (fallback).');
                   lastMessageElement.scrollIntoView({ behavior: 'auto', block: 'end' });
               }, 250);
           }
       }
    // This should be at the absolute end of manageInitialScroll
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    console.log('[OTK Viewer LIFECYCLE] manageInitialScroll: Loading overlay hidden (final).');
   }

function handleViewerScroll() {
    console.log('[OTK Viewer LIFECYCLE] handleViewerScroll: Entered');
    // Ensure viewer is present and visible, and has children to process
    if (!viewer || viewer.style.display === 'none' || !viewer.children.length) {
        console.log('[OTK Viewer ScrollTrack] handleViewerScroll: Viewer hidden, empty, or not found. Exiting.');
        return;
    }

    let currentTopMessageId = null;
    const viewerRectTop = viewer.getBoundingClientRect().top; // Top of the viewport of the viewer itself
    const viewerScrollTop = viewer.scrollTop; // How much the viewer's content has been scrolled

    // Query for direct children of 'viewer' that are message containers
    const messages = viewer.querySelectorAll('div[data-message-id]');

    if (messages.length === 0) {
        console.log('[OTK Viewer ScrollTrack] handleViewerScroll: No message elements with data-message-id found.');
        return;
    }

    console.log('[OTK Viewer ScrollTrack] handleViewerScroll: Checking ' + messages.length + ' messages. Viewer scrollTop: ' + viewerScrollTop);

    // Find the first message whose bottom is below or at the viewer's scrollTop
    // (meaning its top part is likely the first thing visible or just above)
    // OR, more simply, the first message whose visual top is at or below the viewer's visual top.
    for (let i = 0; i < messages.length; i++) {
        const msgElement = messages[i];
        const msgElementRect = msgElement.getBoundingClientRect();

        // msgElementRect.top is relative to the browser viewport.
        // viewerRectTop is the viewer's top relative to the browser viewport.
        // If msgElementRect.top is close to viewerRectTop, it's at the top of the scroll.
        // We want the first message that is at least partially visible at the top.
        // A message is "at the top" if its bottom edge is below the viewer's top edge,
        // and it's the first one encountered.
        if (msgElementRect.bottom > viewerRectTop) {
            currentTopMessageId = msgElement.dataset.messageId;
            console.log('[OTK Viewer ScrollTrack] handleViewerScroll: Identified top-most relevant message ID: ' + currentTopMessageId +
                        ' (MsgRect Top: ' + msgElementRect.top + ', Bottom: ' + msgElementRect.bottom + '; ViewerRect Top: ' + viewerRectTop + ')');
            break; // Found the first one, this is our candidate
        }
    }

    // If, after checking all messages, none were found meeting the criteria (e.g. all scrolled way up)
    // and there are messages, just take the first message in the list as a failsafe.
    // This state should be rare if viewer is scrollable and has messages.
    if (!currentTopMessageId && messages.length > 0) {
        currentTopMessageId = messages[0].dataset.messageId;
        console.log('[OTK Viewer ScrollTrack] handleViewerScroll: No message strictly at top, defaulting to first message ID in DOM: ' + currentTopMessageId);
    }

    if (currentTopMessageId) {
        if (sessionStorage.getItem('otkLastScrolledMessageId') !== currentTopMessageId) {
            sessionStorage.setItem('otkLastScrolledMessageId', currentTopMessageId);
            console.log('[OTK Viewer Scroll] Stored/Updated last scrolled message ID in sessionStorage: ' + currentTopMessageId);
        }
    } else {
        console.log('[OTK Viewer ScrollTrack] handleViewerScroll: Could not determine a top message ID to store.');
    }
}

    // Convert >>123456 to link text "123456" with class 'quote'
    // We'll link to the message number in viewer and use it for quote expansion
    // Also handles YouTube, X/Twitter, Rumble, Twitch, Streamable, and general links.
    function convertQuotes(text, embedCounts) {
        // Unescape HTML entities first
        text = decodeEntities(text);

        // Define regexes (ensure global flag 'g' is used)
        // YouTube regex now captures video ID (group 1) and all parameters (group 2)
        const youtubeRegexG = /https?:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)((?:[?&][a-zA-Z0-9_=&%.:+-]*)*)/g;
        const twitterRegexG = /(https?:\/\/(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/([0-9]+))/g;
        const rumbleRegexG = /https?:\/\/rumble\.com\/(?:embed\/)?(v[a-zA-Z0-9]+)(?:-[^\s"'>?&.]*)?(?:\.html)?(?:\?[^\s"'>]*)?/g;
        const twitchClipRegexG = /https?:\/\/(?:clips\.twitch\.tv\/|(?:www\.)?twitch\.tv\/[a-zA-Z0-9_]+\/clip\/)([a-zA-Z0-9_-]+)(?:\?[^\s"'>]*)?/g;
        // Twitch VOD regex now captures VOD ID (group 1) and all parameters (group 2)
        const twitchVodRegexG = /https?:\/\/(?:www\.)?twitch\.tv\/videos\/([0-9]+)((?:[?&][a-zA-Z0-9_=&%.:+-]*)*)/g;
        const streamableRegexG = /https?:\/\/streamable\.com\/([a-zA-Z0-9]+)(?:\?[^\s"'>]*)?/g;
        const generalLinkRegexG = /(?<!(?:href="|src="))https?:\/\/[^\s<>"']+[^\s<>"'.?!,:;)]/g;
        const quoteLinkRegexG = /&gt;&gt;(\d+)/g;

        // Order of operations:
        // 1. YouTube
        text = text.replace(youtubeRegexG, (match, videoId, allParams) => {
            const startTime = getTimeFromParams(allParams);
            return `__YOUTUBE_EMBED__[${videoId}]__[${startTime || ''}]__`;
        });

        // 2. X/Twitter
        text = text.replace(twitterRegexG, (match, originalUrl, tweetId) => {
            const hiddenUrl = originalUrl.replace(/^https?:\/\//, "TWITTER_URL_SCHEME_PLACEHOLDER://");
            return `__TWITTER_EMBED__[${tweetId}]__LINK:${hiddenUrl}__`;
        });

        // 3. Rumble
        text = text.replace(rumbleRegexG, (match, rumbleIdWithV) => {
            const hiddenUrl = match.replace(/^https?:\/\//, "RUMBLE_URL_SCHEME_PLACEHOLDER://"); // 'match' is the full original URL
            return `__RUMBLE_EMBED__[${rumbleIdWithV}]__LINK:${hiddenUrl}__`;
        });

        // 4. Twitch Clips
        text = text.replace(twitchClipRegexG, (match, clipId) => `__TWITCH_CLIP_EMBED__[${clipId}]__`);

        // 5. Twitch VODs
        text = text.replace(twitchVodRegexG, (match, vodId, allParams) => {
            const startTime = getTimeFromParams(allParams); // getTimeFromParams returns total seconds or null
            return `__TWITCH_VOD_EMBED__[${vodId}]__[${startTime || ''}]__`;
        });

        // 6. Streamable
        text = text.replace(streamableRegexG, (match, videoId) => `__STREAMABLE_EMBED__[${videoId}]__`);

        // 7. General links (must come after specific platform placeholders)
        text = text.replace(generalLinkRegexG, (match) => {
            // Avoid re-processing placeholders for YouTube, Twitter, Rumble, Twitch or Streamable
            if (match.includes("__YOUTUBE_EMBED__") || match.includes("__TWITTER_EMBED__") || match.includes("__RUMBLE_EMBED__") || match.includes("__TWITCH_CLIP_EMBED__") || match.includes("__TWITCH_VOD_EMBED__") || match.includes("__STREAMABLE_EMBED__")) {
                return match;
            }
            return `<a href="${match}" target="_blank" rel="noopener noreferrer">${match}</a>`;
        });

        // 8. >>123 style quotes
        text = text.replace(quoteLinkRegexG, (match, p1) => `<a href="#" class="quote" data-postid="${p1}">${p1}</a>`);

        // Final placeholder replacements:
        // 9. YouTube embeds
        text = text.replace(/__YOUTUBE_EMBED__\[([a-zA-Z0-9_-]+)\]__\[([0-9]*)\]__/g, (match, videoId, startTime) => {
            if (embedCounts && embedCounts.hasOwnProperty('youtube')) embedCounts.youtube++;
            const thumbUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
            let attributes = `class="embed-placeholder youtube-placeholder" data-embed-type="youtube" data-video-id="${videoId}" data-loaded="false" tabindex="0"`;
            if (startTime) attributes += ` data-start-time="${startTime}"`;
            return `<div ${attributes} style="background-image: url('${thumbUrl}');">
                    <div class="play-button-overlay">▶</div>
                </div>`;
        });

        // 10. X/Twitter embeds/links
        text = text.replace(/__TWITTER_EMBED__\[([0-9]+)\]__LINK:(.*?)__/g, (match, tweetId, hiddenUrlFromPlaceholder) => {
            const originalUrl = hiddenUrlFromPlaceholder.replace(/^TWITTER_URL_SCHEME_PLACEHOLDER:\/\//, "https://");
            // The existing console.log can be updated to show 'originalUrl' to verify the fix during testing by the user.
            console.log('VIEWER_DEBUG_TRY2: Twitter originalUrl:', originalUrl, 'Tweet ID:', tweetId);
            return createTwitterEmbedPlaceholder(tweetId, originalUrl); // Changed function call
        });

        // 11. Rumble embeds
        text = text.replace(/__RUMBLE_EMBED__\[(v[a-zA-Z0-9]+)\]__LINK:(.*?)__/g, (match, rumbleIdWithV, hiddenUrlFromPlaceholder) => {
            const originalUrl = hiddenUrlFromPlaceholder.replace(/^RUMBLE_URL_SCHEME_PLACEHOLDER:\/\//, "https://");
            return createRumbleEmbed(rumbleIdWithV, originalUrl);
        });

        // 12. Twitch Clip embeds
        text = text.replace(/__TWITCH_CLIP_EMBED__\[([a-zA-Z0-9_-]+)\]__/g, (match, clipId) => {
            if (embedCounts && embedCounts.hasOwnProperty('twitch')) embedCounts.twitch++;
            // No easily accessible thumbnail for clips without API, use generic placeholder
            return `<div class="embed-placeholder twitch-placeholder" data-embed-type="twitch-clip" data-video-id="${clipId}" data-loaded="false" tabindex="0">
                    <div class="play-button-overlay">▶</div>
                    <span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">Twitch Clip</span>
                </div>`;
        }); // Clips don't use startTimeSeconds from URL like VODs

        // 13. Twitch VOD embeds
        text = text.replace(/__TWITCH_VOD_EMBED__\[([0-9]+)\]__\[([0-9]*)\]__/g, (match, vodId, startTime) => {
            if (embedCounts && embedCounts.hasOwnProperty('twitch')) embedCounts.twitch++;
            let attributes = `class="embed-placeholder twitch-placeholder" data-embed-type="twitch-vod" data-video-id="${vodId}" data-loaded="false" tabindex="0"`;
            if (startTime) attributes += ` data-start-time="${startTime}"`;
            // No easily accessible thumbnail for VODs without API
            return `<div ${attributes}>
                    <div class="play-button-overlay">▶</div>
                    <span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">Twitch VOD</span>
                </div>`;
        });

        // 14. Streamable embeds
        text = text.replace(/__STREAMABLE_EMBED__\[([a-zA-Z0-9]+)\]__/g, (match, videoId) => {
            if (embedCounts && embedCounts.hasOwnProperty('streamable')) embedCounts.streamable++;
            // No easily accessible thumbnail for Streamable without API
            return `<div class="embed-placeholder streamable-placeholder" data-embed-type="streamable" data-video-id="${videoId}" data-loaded="false" tabindex="0">
                    <div class="play-button-overlay">▶</div>
                    <span style="position:absolute; bottom:5px; font-size:10px; color:rgba(255,255,255,0.7);">Streamable Video</span>
                </div>`;
        });

        return text;
    }

    // Load storage data
    let activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
    let messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
    try {
        const threadIds = Object.keys(messagesByThreadId);
        let totalMessages = 0;
        threadIds.forEach(tid => {
            totalMessages += (messagesByThreadId[tid] || []).length;
        });
        console.log('[OTK Viewer Metrics] Loaded messagesByThreadId:');
        console.log(`    - Thread count: ${threadIds.length}`);
        console.log(`    - Total messages stored: ${totalMessages}`);
        console.log(`    - Estimated size (JSON string length): ${JSON.stringify(messagesByThreadId).length} characters`);
    } catch (e) {
        console.error('[OTK Viewer Metrics] Error calculating messagesByThreadId stats:', e);
    }
    let threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};

    // Create or get viewer container
    let viewer = document.getElementById('otk-thread-viewer');
    if (!viewer) {
        viewer = document.createElement('div');
        viewer.id = 'otk-thread-viewer';
        viewer.style.cssText = `
            position: fixed;
            top: 0;
            left: 0; right: 0; bottom: 0;
            background: #fff4de;
            overflow-y: auto;
            padding: 10px 20px;
            font-family: Verdana, sans-serif;
            font-size: 14px;
            z-index: 9998; /* Keep below tracker bar if tracker bar is to remain visible */
            display: none; /* start hidden */
        `;
        document.body.appendChild(viewer);
    }

    let loadingOverlay = document.getElementById('otk-loading-overlay');
    if (!loadingOverlay) {
        loadingOverlay = document.createElement('div');
        loadingOverlay.id = 'otk-loading-overlay';
        loadingOverlay.textContent = 'Loading OTK Viewer...'; // Or similar text
        loadingOverlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(20, 20, 20, 0.85); /* Darker semi-transparent background */
            color: #f0f0f0; /* Light text color */
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px; /* Adjusted font size */
            font-family: Verdana, sans-serif; /* Consistent font */
            z-index: 10001; /* Higher than viewer content, potentially below a global close button if one existed */
            display: none; /* Initially hidden */
        `;
        document.body.appendChild(loadingOverlay);
    }

    // Inject CSS for selected messages
    if (!document.getElementById('otk-viewer-styles')) {
        const styleSheet = document.createElement("style");
        styleSheet.id = 'otk-viewer-styles';
        styleSheet.type = "text/css";
        styleSheet.innerText = `
            .selected-message {
                background-color: #E0E0E0 !important;
                box-shadow: 0 0 5px rgba(0,0,0,0.3) !important;
            }
.embed-placeholder {
    position: relative;
    width: 100%;
    max-width: 560px; /* Added back */
    aspect-ratio: 16 / 9; /* Maintain aspect ratio */
    background-color: #2c2c2c; /* Darker background */
    background-size: cover;
    background-position: center;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 8px 0; /* For left-alignment */
    border: 1px solid #444;
    color: white; /* For any text inside if needed */
    overflow: hidden; /* Ensure play button doesn't overflow weirdly */
}
.embed-placeholder:focus, .embed-placeholder:hover {
    border-color: #888;
    outline: 2px solid #0078D4; /* Focus indicator */
}
.play-button-overlay {
    font-size: 40px;
    color: rgba(255, 255, 255, 0.9);
    background-color: rgba(0, 0, 0, 0.6);
    border-radius: 50%;
    width: 70px;
    height: 70px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-shadow: 0 0 8px black;
    pointer-events: none; /* Click goes to parent div */
    border: 2px solid rgba(255, 255, 255, 0.5);
}
.embed-placeholder[data-loaded="true"] { /* When iframe is loaded inside */
    background-image: none !important;
    border-color: transparent; /* Or specific styling for loaded state */
    padding: 0; /* Remove padding if iframe takes full space */
}
.embed-placeholder[data-loaded="true"] .play-button-overlay {
    display: none;
}
.youtube-placeholder { /* Specific styling if needed, e.g. min-height if aspect-ratio fails */ }
.twitch-placeholder { background-color: #3a265c; /* Darker Twitch purple */ }
.streamable-placeholder { background-color: #1c3d52; /* Darker Streamable blue */ }
        `;
        document.head.appendChild(styleSheet);
    }

    // Helper: Find message by post id across all threads
    function findMessage(postId) {
        for (const threadId of activeThreads) {
            const msgs = messagesByThreadId[threadId] || [];
            for (const msg of msgs) {
                if (msg.id === parseInt(postId)) return { msg, threadId };
            }
        }
        return null;
    }

    // Render single message with recursive quoted messages above
    function renderMessageWithQuotes(msg, threadId, depth = 0, ancestors = [], embedCounts, renderedFullSizeImages) {
        if (ancestors.includes(msg.id)) {
            // Detected a circular quote, stop rendering this branch.
            // Return a comment node or an empty document fragment.
            const comment = document.createComment(`Skipping circular quote to post ${msg.id}`);
            return comment;
        }
        const color = threadColors[threadId] || '#888';

        // Create container div for quoted messages (recursively)
        const container = document.createElement('div');
        // container.style.marginLeft = `${depth * 20}px`; // Removed to align all messages
        if (depth === 0) {
            container.style.backgroundColor = '#fff';
            container.dataset.messageId = msg.id; // Set data-message-id for top-level messages

            // Add click event listener for selection
            container.addEventListener('click', function(event) {
                const currentSelectedId = localStorage.getItem(SELECTED_MESSAGE_KEY);
                const thisMessageId = String(msg.id); // Ensure string comparison

                // Deselect if clicking the already selected message
                if (currentSelectedId === thisMessageId) {
                    localStorage.removeItem(SELECTED_MESSAGE_KEY);
                    this.classList.remove('selected-message');
                } else {
                    // Remove highlight from previously selected message
                    const previouslySelected = viewer.querySelector('.selected-message');
                    if (previouslySelected) {
                        previouslySelected.classList.remove('selected-message');
                    }

                    // Store new selected message ID and highlight it
                    localStorage.setItem(SELECTED_MESSAGE_KEY, thisMessageId);
                    sessionStorage.removeItem('otkLastScrolledMessageId'); // <--- ADD THIS LINE
                    console.log('[OTK Viewer Scroll] Cleared lastScrolledMessageId due to explicit selection.');
                    this.classList.add('selected-message');
                }
                event.stopPropagation(); // Stop event from bubbling
            });

        } else {
            // Alternating backgrounds for quoted messages
            container.style.backgroundColor = (depth % 2 === 1) ? 'rgba(0,0,0,0.05)' : '#fff';
        }
        container.style.borderRadius = '4px';
        container.style.padding = '6px 8px';
        container.style.marginBottom = '8px';

        if (depth === 0) {
            container.style.borderBottom = '1px solid #ccc';
            // Optionally, adjust padding or margin if the border makes spacing awkward
            // For example, increase bottom padding or change margin:
            container.style.paddingBottom = '10px'; // Increase padding to give content space from border
            container.style.marginBottom = '15px'; // Increase margin to space out from next main message
        }

        // Find quotes in this message text
        const quoteIds = [];
        const quoteRegex = /&gt;&gt;(\d+)/g;
        let m;
        while ((m = quoteRegex.exec(msg.text)) !== null) {
            quoteIds.push(m[1]);
        }

        // Render quoted messages recursively (above)
        for (const qid of quoteIds) {
            const found = findMessage(qid);
            if (found) {
                const quotedEl = renderMessageWithQuotes(found.msg, found.threadId, depth + 1, [...ancestors, msg.id], embedCounts, renderedFullSizeImages);
                container.appendChild(quotedEl);
            }
        }

        // Create main message div
        const postDiv = document.createElement('div');
        postDiv.style.display = 'flex';
        postDiv.style.alignItems = 'flex-start';

        if (depth === 0) {
            // Color square
            const colorSquare = document.createElement('div');
            colorSquare.style.cssText = `
                width: 15px;
                height: 40px;
                background-color: ${color};
                border-radius: 3px;
                margin-right: 10px;
                flex-shrink: 0;
            `;
            postDiv.appendChild(colorSquare);
        }

        const textWrapperDiv = document.createElement('div');
        textWrapperDiv.style.display = 'flex';
        textWrapperDiv.style.flexDirection = 'column';

        // Post number and timestamp container
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'margin-right: 10px; font-size: 12px; color: #555; flex-shrink: 0; white-space: nowrap;';
        const dt = new Date(msg.time * 1000);
        headerDiv.textContent = `#${msg.id} ${dt.toLocaleString()}`;
        textWrapperDiv.appendChild(headerDiv);

        // Content
        const contentDiv = document.createElement('div');
        contentDiv.classList.add('post-content');
        contentDiv.style.whiteSpace = 'pre-wrap';
        contentDiv.innerHTML = convertQuotes(msg.text, embedCounts);
        textWrapperDiv.appendChild(contentDiv);

        if (msg.attachment && msg.attachment.tim) {
            const attach = msg.attachment;
            const board = 'b'; // Assuming 'b' for now, ideally this could be more dynamic if script were for multiple boards
            const thumbUrl = `https://i.4cdn.org/${board}/${attach.tim}s.jpg`;
            const fullUrl = `https://i.4cdn.org/${board}/${attach.tim}${attach.ext}`;

            const textWrapper = textWrapperDiv; // textWrapperDiv is where the thumb/full media will go

            const createThumbnail = () => {
                const thumbnailWrapper = document.createElement('div');
                // Optional: Add any specific styles to thumbnailWrapper if needed, e.g., thumbnailWrapper.style.marginBottom = '5px';

                const thumb = document.createElement('img');
                const board = 'b'; // Assuming 'b' for now
                const networkThumbUrl = `https://i.4cdn.org/${board}/${attach.tim}s.jpg`;

                // Initial setup for alt, title, and styles that apply to both placeholder and final image
                thumb.alt = attach.filename;
                thumb.title = 'Click to view ' + attach.filename + ' (' + attach.w + 'x' + attach.h + ')';
                thumb.style.maxWidth = attach.tn_w + 'px';
                thumb.style.maxHeight = attach.tn_h + 'px';
                thumb.style.cursor = 'pointer';
                thumb.style.marginTop = '5px';
                thumb.style.borderRadius = '3px';
                thumb.style.border = '1px solid transparent'; // Placeholder for border if needed
                thumb.style.display = 'block'; // Ensure this is present
                thumb.dataset.isThumbnail = "true";

                // Generic error handler for final failure (e.g., network error, corrupted cache)
                const showLoadError = function() {
                    console.warn('[OTK Cache/Thumb] Thumbnail failed to load definitively for original src:', networkThumbUrl);
                    this.alt = 'Image deleted or unavailable';
                    this.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"%3E%3Crect width="120" height="120" fill="%23e0e0e0"%3E%3C/rect%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14px" fill="%23757575"%3EImg N/A%3C/text%3E%3C/svg%3E';
                    this.style.width = '120px';
                    this.style.height = '120px';
                    this.style.maxWidth = '120px';
                    this.style.maxHeight = '120px';
                    this.style.objectFit = 'contain';
                    this.style.border = '1px dashed #aaa';
                    this.style.padding = '5px';
                    this.title = 'Image deleted or unavailable';
                    this.onerror = null; // Prevent loops
                    this.onload = null;  // Clear any pending onload
                };

                thumb.onerror = showLoadError; // Set early for any src assignment issues
                thumbnailWrapper.appendChild(thumb);


                (async () => {
                    try {
                        const cachedBlob = await getMedia(networkThumbUrl);
                        if (cachedBlob) {
                            console.log('[OTK Cache] createThumbnail: Using cached blob for', networkThumbUrl);
                            const objectURL = URL.createObjectURL(cachedBlob);
                            thumb.onload = () => {
                                URL.revokeObjectURL(objectURL); // Clean up after image is loaded
                                console.log('[OTK Cache] createThumbnail: ObjectURL loaded into img for', networkThumbUrl);
                                thumb.style.border = '1px solid transparent'; // Reset border on successful load
                                thumb.onload = null; // Clear this specific onload
                            };
                            // If ObjectURL fails to load, thumb.onerror (showLoadError) will trigger
                            thumb.src = objectURL;
                        } else {
                            console.log('[OTK Cache] createThumbnail: Not in cache, fetching from network:', networkThumbUrl);
                            thumb.onload = async function() { // Network image loaded successfully
                                console.log('[OTK Cache] createThumbnail: Network thumbnail loaded successfully:', networkThumbUrl);
                                try {
                                    // Fetch again to get blob for caching.
                                    // Use { cache: 'default' } or rely on browser's default caching for this fetch.
                                    // If the image just loaded into thumb.src, it might be in HTTP cache.
                                    const response = await fetch(networkThumbUrl);
                                    if (!response.ok) {
                                        throw new Error('Network response not OK for blob fetch: ' + response.status);
                                    }
                                    const blobToCache = await response.blob();
                                    if (blobToCache.size > 0) {
                                        await saveMedia(networkThumbUrl, blobToCache, attach.filename, attach.ext);
                                    } else {
                                        console.warn('[OTK Cache] createThumbnail: Fetched blob for caching is empty, not caching:', networkThumbUrl);
                                    }
                                } catch (cacheError) {
                                    console.error('[OTK Cache] createThumbnail: Failed to fetch/cache network thumbnail:', networkThumbUrl, cacheError.message);
                                }
                                thumb.style.border = '1px solid transparent'; // Reset border on successful load
                                this.onload = null; // Clear this specific onload
                            };
                            // If network fetch fails, thumb.onerror (showLoadError) will trigger
                            thumb.src = networkThumbUrl;
                        }
                    } catch (err) {
                        console.error('[OTK Cache] createThumbnail: Error in async loading logic or getMedia for', networkThumbUrl, err.message);
                        showLoadError.call(thumb); // Call error handler in context of thumb
                    }
                })();

                thumb.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 'attach' is from the outer scope of createThumbnail
                    const fullMedia = createFullMedia(); // createFullMedia also uses 'attach'
                    thumbnailWrapper.parentNode.replaceChild(fullMedia, thumbnailWrapper); // Replace wrapper
                });
                return thumbnailWrapper;
            };

            const createFullMedia = () => {
                let mediaElement;
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(attach.ext.toLowerCase())) {
                    mediaElement = document.createElement('img');
                    // Apply initial styles that don't depend on src, and alt/title
                    mediaElement.alt = attach.filename;
                    mediaElement.title = 'Click to view thumbnail for ' + attach.filename; // Or similar
                    mediaElement.style.maxWidth = '100%';
                    mediaElement.style.maxHeight = '70vh';
                    mediaElement.style.display = 'block';
                    mediaElement.style.marginTop = '5px';
                    mediaElement.style.borderRadius = '3px';
                    mediaElement.style.cursor = 'pointer';
                    // Ensuring the requested styles are present
                    mediaElement.style.width = 'auto';
                    mediaElement.style.height = 'auto';
                    mediaElement.style.objectFit = 'contain';
                    mediaElement.dataset.isThumbnail = "false";

                    const networkFullUrl = fullUrl; // fullUrl is already defined in createFullMedia's scope

                    // The existing onerror handler (added in previous steps)
                    const existingOnError = function() {
                        console.warn('[OTK Viewer Media] Full-size image failed to load (onerror triggered for):', this.src);
                        this.alt = 'Full image deleted or unavailable';
                        this.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"%3E%3Crect width="200" height="150" fill="%23d3d3d3"%3E%3C/rect%3E%3Ctext x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="16px" fill="%23707070"%3EImage Unavailable%3C/text%3E%3C/svg%3E';
                        this.style.width = '200px';
                        this.style.height = '150px';
                        this.style.maxWidth = '200px';
                        this.style.maxHeight = '150px';
                        this.style.objectFit = 'contain';
                        this.style.border = '1px dashed #aaa';
                        this.style.padding = '10px';
                        this.style.backgroundColor = '#f0f0f0';
                        this.title = 'Full image deleted or unavailable';
                        this.onclick = null;
                        this.onerror = null;
                    };
                    mediaElement.onerror = existingOnError;

                    (async () => {
                        try {
                            const cachedBlob = await getMedia(networkFullUrl);
                            if (cachedBlob) {
                                console.log('[OTK Cache] createFullMedia (Image): Using cached blob for', networkFullUrl);
                                const objectURL = URL.createObjectURL(cachedBlob);
                                mediaElement.onload = () => {
                                    URL.revokeObjectURL(objectURL);
                                    console.log('[OTK Cache] createFullMedia (Image): ObjectURL loaded into img for', networkFullUrl);
                                    mediaElement.style.border = ''; // Clear any error border if one was set
                                    mediaElement.onload = null;
                                };
                                mediaElement.src = objectURL;
                            } else {
                                console.log('[OTK Cache] createFullMedia (Image): Not in cache, fetching from network:', networkFullUrl);
                                mediaElement.onload = async function() {
                                    console.log('[OTK Cache] createFullMedia (Image): Network full image loaded successfully:', networkFullUrl);
                                    try {
                                        const response = await fetch(networkFullUrl, { cache: 'default' }); // Try to use HTTP cache
                                        if (!response.ok) {
                                            throw new Error('Network response not OK for blob fetch: ' + response.status);
                                        }
                                        const blobToCache = await response.blob();
                                        if (blobToCache.size > 0) {
                                            await saveMedia(networkFullUrl, blobToCache, attach.filename, attach.ext);
                                        } else {
                                            console.warn('[OTK Cache] createFullMedia (Image): Fetched blob for caching is empty for', networkFullUrl);
                                        }
                                    } catch (cacheError) {
                                        console.error('[OTK Cache] createFullMedia (Image): Failed to fetch/cache network image:', networkFullUrl, cacheError.message);
                                    }
                                    mediaElement.style.border = ''; // Clear any error border
                                    this.onload = null;
                                };
                                mediaElement.src = networkFullUrl; // Trigger network load
                            }
                        } catch (err) {
                            console.error('[OTK Cache] createFullMedia (Image): Error in async loading logic or getMedia for', networkFullUrl, err.message);
                            existingOnError.call(mediaElement); // Call error handler in context of mediaElement
                        }
                    })();
                    // The click listener to revert to thumbnail is added AFTER this if/else if block by existing code.
                } else if (['.webm', '.mp4'].includes(attach.ext.toLowerCase())) {
                    const videoContainer = document.createElement('div');
                    videoContainer.className = 'direct-video-container'; // For potential styling
                    videoContainer.style.padding = '10px';
                    videoContainer.style.border = '1px solid #eee';
                    videoContainer.style.minHeight = '50px';
                    videoContainer.style.display = 'flex';
                    videoContainer.style.alignItems = 'center';
                    videoContainer.style.justifyContent = 'center';
                    videoContainer.textContent = 'Checking media availability...';

                    (async () => {
                        try {
                            const response = await fetch(fullUrl, { method: 'HEAD', cache: "no-store" });

                            if (response.ok) { // status 200-299
                                if (!videoContainer.isConnected) {
                                    console.log(`[OTK Viewer Media] Video container for ${fullUrl} (ID: ${attach.tim}) was detached from DOM before video element could be added. Aborting video setup for this instance.`);
                                    return;
                                }
                                console.log('[OTK Viewer Media] HEAD request OK for video:', fullUrl);
                                const videoElement = document.createElement('video');
                                videoElement.src = fullUrl;
                                videoElement.controls = true;
                                videoElement.autoplay = false;
                                videoElement.preload = 'metadata';
                                videoElement.loop = true;

                                videoElement.style.maxWidth = '100%';
                                videoElement.style.maxHeight = '70vh';
                                videoElement.style.display = 'block';

                                videoContainer.innerHTML = '';
                                videoContainer.style.padding = '0';
                                videoContainer.style.border = 'none';
                                videoContainer.style.minHeight = '';
                                videoContainer.style.display = 'block';
                                videoContainer.appendChild(videoElement);
                                videoElement.load(); // <--- ADD THIS LINE
                            } else {
                                console.warn('[OTK Viewer Media] HEAD request FAILED (status ' + response.status + ') for video:', fullUrl);
                                videoContainer.textContent = 'Video deleted or unavailable (' + response.status + ')';
                                videoContainer.style.justifyContent = 'flex-start';
                                videoContainer.style.alignItems = 'flex-start';
                            }
                        } catch (error) {
                            console.error('[OTK Viewer Media] Network error during video HEAD request for:', fullUrl, error.message);
                            videoContainer.textContent = 'Video check failed (Network error: ' + error.message + ')';
                            videoContainer.style.justifyContent = 'flex-start';
                            videoContainer.style.alignItems = 'flex-start';
                        }
                    })();
                    mediaElement = videoContainer;
                } else {
                    // Fallback for unsupported types, or just don't create mediaElement
                    const unsupportedText = document.createElement('span');
                    unsupportedText.textContent = `[Unsupported file type: ${attach.ext}]`;
                    return unsupportedText;
                }

                mediaElement.style.maxWidth = '100%';
                mediaElement.style.maxHeight = '70vh';
                mediaElement.style.display = 'block';
                mediaElement.style.marginTop = '5px';
                mediaElement.style.borderRadius = '3px';
                mediaElement.style.cursor = 'pointer';
                // ---- START of intended changes for image elements ----
                mediaElement.style.width = 'auto';
                mediaElement.style.height = 'auto';
                mediaElement.style.objectFit = 'contain';
                // ---- END of intended changes for image elements ----
                mediaElement.dataset.isThumbnail = "false"; // Mark as full media

                mediaElement.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newThumbnail = createThumbnail();
                    if (mediaElement.parentNode) { mediaElement.parentNode.replaceChild(newThumbnail, mediaElement); } else { console.error('[OTK Viewer] Error reverting to thumbnail: full media element has no parent.'); }
                });
                return mediaElement;
            };

            // const textWrapper = textWrapperDiv; // Already defined

            // createThumbnail and createFullMedia are defined within this scope
            // We need to pass 'attach' to them explicitly if they don't already capture it.
            // Looking at the code, createThumbnail and createFullMedia capture 'attach' from their parent scope.

            const attachExt = attach.ext.toLowerCase();

            if (attachExt === '.webm' || attachExt === '.mp4') {
                console.log(`[OTK Viewer] Directly embedding video player for: ${attach.filename}${attachExt}`);
                const fullVideoPlayer = createFullMedia(); // createFullMedia uses 'attach' from its closure
                contentDiv.appendChild(fullVideoPlayer);
            } else { // Handles images (jpg, png, gif)
                if (renderedFullSizeImages.has(attach.tim)) {
                    // Already shown full-size, render as thumbnail
                    console.log(`[OTK Viewer] Rendering REPEAT image as thumbnail: ${attach.filename}${attach.ext} (TIM: ${attach.tim})`);
                    const initialThumb = createThumbnail(); // createThumbnail now returns a div wrapper
                    contentDiv.appendChild(initialThumb);
                } else {
                    // First time seeing this image, render full-size
                    console.log(`[OTK Viewer] Rendering FIRST instance of image as FULL-SIZE: ${attach.filename}${attach.ext} (TIM: ${attach.tim})`);
                    const fullImageDisplay = createFullMedia(); // createFullMedia handles image display
                    contentDiv.appendChild(fullImageDisplay);
                    renderedFullSizeImages.add(attach.tim);
                }
            }
        } // End of if (msg.attachment && msg.attachment.tim)
        postDiv.appendChild(textWrapperDiv);

        container.appendChild(postDiv);
        return container;
    }

    // Render all messages chronologically across all threads
    async function renderAllMessages() {
        const renderedFullSizeImages = new Set();
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Entered');
        viewer.innerHTML = '';

        if (embedObserver) {
            embedObserver.disconnect(); // Disconnect previous observer if any
        }
        const observerOptions = {
            root: viewer, // Observe intersections within the viewer scrollable area
            rootMargin: '300px 0px 300px 0px', // Load when 300px from viewport edge
            threshold: 0.01 // Trigger when even 1% is visible
        };
        embedObserver = new IntersectionObserver(handleIntersection, observerOptions);

        // Gather all messages in one array with threadId info
        let allMessages = [];
        activeThreads.forEach(threadId => {
            const msgs = messagesByThreadId[threadId] || [];
            msgs.forEach(m => allMessages.push({ ...m, threadId }));
        });

        // Sort by time ascending
        allMessages.sort((a, b) => a.time - b.time);

        console.log(`[OTK Viewer Metrics] renderAllMessages: Processing ${allMessages.length} total messages for display.`);
        let attachmentStats = { images: 0, videos: 0, other: 0 };
        let embedCounts = { youtube: 0, twitch: 0, streamable: 0 };

        // Render all messages
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: About to start allMessages.forEach loop. Message count: ' + allMessages.length);
        allMessages.forEach(msg => {
            console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Loop: START processing message ID ' + msg.id);
            const msgEl = renderMessageWithQuotes(msg, msg.threadId, 0, [], embedCounts, renderedFullSizeImages);
            // Selection class is now primarily handled by restoreSelectedMessageState upon loading all messages
            viewer.appendChild(msgEl);
            // Inside the allMessages.forEach loop, after msgEl is created
            if (msg.attachment && msg.attachment.ext) {
                const ext = msg.attachment.ext.toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
                    attachmentStats.images++;
                } else if (['.webm', '.mp4'].includes(ext)) {
                    attachmentStats.videos++;
                } else {
                    attachmentStats.other++;
                }
            }
            console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Loop: END processing message ID ' + msg.id);
        });
        console.log('[OTK Viewer LIFECYCLE] renderAllMessages: Successfully FINISHED allMessages.forEach loop.');

        // Add listener for quote links to scroll to quoted message
        viewer.querySelectorAll('a.quote').forEach(link => {
            link.addEventListener('click', e => {
                e.preventDefault();
                const targetId = parseInt(link.dataset.postid);
                // Scroll to message with this id if found
                const targets = viewer.querySelectorAll('div');
                for (const el of targets) {
                    if (el.textContent.includes(`#${targetId} `)) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        // Highlight briefly
                        el.style.backgroundColor = '#ffff99';
                        setTimeout(() => {
                            el.style.backgroundColor = '';
                        }, 1500);
                        break;
                    }
                }
            });
        });

        console.log('[OTK Viewer Metrics] renderAllMessages: Attachment stats from processed messages:');
        console.log(`    - Images: ${attachmentStats.images}`);
        console.log(`    - Videos: ${attachmentStats.videos}`);
        console.log(`    - Other: ${attachmentStats.other}`);
        console.log('[OTK Viewer Metrics] renderAllMessages: Embed counts from processed messages:');
        console.log(`    - YouTube: ${embedCounts.youtube}`);
        console.log(`    - Twitch: ${embedCounts.twitch}`);
        console.log(`    - Streamable: ${embedCounts.streamable}`);
        try {
            const renderedMessageElements = viewer.querySelectorAll('div[data-message-id]');
            console.log(`[OTK Viewer Metrics] renderAllMessages: Rendered ${renderedMessageElements.length} top-level message DOM elements.`);
        } catch(e) {
            console.error('[OTK Viewer Metrics] Error counting rendered message elements:', e);
        }

        // After all messages are in the DOM, process any Twitter embed placeholders
        await processTweetEmbeds(viewer); // Keep this call

        const currentPlaceholders = viewer.querySelectorAll('.embed-placeholder');
        console.log(`[OTK Viewer IO] Observing ${currentPlaceholders.length} media placeholders.`);
        currentPlaceholders.forEach(ph => {
            if (embedObserver) embedObserver.observe(ph);
        });

        if (!viewer.dataset.scrollListenerAttached) {
            const debouncedViewerScrollHandler = debounce(handleViewerScroll, 500); // 500ms debounce
            viewer.addEventListener('scroll', debouncedViewerScrollHandler);
            viewer.dataset.scrollListenerAttached = 'true';
            console.log('[OTK Viewer Scroll] Attached debounced scroll listener to viewer.');
        }

        setTimeout(() => {
            console.log('[OTK Viewer LIFECYCLE] setTimeout: Calling manageInitialScroll after 750ms delay.');
            manageInitialScroll();
        }, 750); // 750ms delay
    }

    // Toggle viewer display
    function toggleViewer() {
        const bar = document.getElementById('otk-thread-bar'); // Get the black bar

        if (viewer.style.display === 'none' || viewer.style.display === '') { // Logic to SHOW viewer
            console.log('[OTK Viewer] toggleViewer: Attempting to SHOW viewer.');
            console.log('[OTK Viewer EXECUTION] toggleViewer: Path to SHOW viewer entered (after initial display check).');
            localStorage.setItem('otkViewerVisible', 'true');
            if (loadingOverlay) {
                loadingOverlay.style.setProperty('display', 'flex', 'important');
                console.log('[OTK Loading Indicator] Attempted to show loadingOverlay. Style display:', loadingOverlay.style.display, 'Computed display:', window.getComputedStyle(loadingOverlay).display);
                void loadingOverlay.offsetHeight; /* Force browser reflow */
                console.log('[OTK Loading Indicator] Forced reflow for loadingOverlay.');
            }
            renderAllMessages(); // Render content first
            viewer.style.display = 'block'; // Make the viewer visible

            // Adjust viewer padding and hide other page elements
            const barElement = document.getElementById('otk-thread-bar'); // bar is already defined at function scope
            let calculatedPaddingTop = '60px'; // Default/fallback if bar not found or height is 0
            if (barElement && barElement.offsetHeight > 0) {
                calculatedPaddingTop = barElement.offsetHeight + 'px';
            }
            viewer.style.paddingTop = calculatedPaddingTop;
            viewer.style.paddingLeft = '20px'; // Ensure consistent padding
            viewer.style.paddingRight = '20px';
            viewer.style.paddingBottom = '10px';

            originalBodyOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            otherBodyNodes = [];
            Array.from(document.body.childNodes).forEach(node => {
                if (node !== viewer && node !== bar && node.nodeType === Node.ELEMENT_NODE) {
                    if (node.style && node.style.display !== 'none') {
                        otherBodyNodes.push({ node: node, originalDisplay: node.style.display });
                        node.style.display = 'none';
                    } else if (!node.style && node.tagName !== 'SCRIPT' && node.tagName !== 'LINK') {
                        otherBodyNodes.push({ node: node, originalDisplay: '' });
                        node.style.display = 'none';
                    }
                }
            });

            if (bar) { // 'bar' is already defined at the top of toggleViewer
                bar.style.zIndex = '10000';
            }
        } // END OF IF BLOCK TO SHOW VIEWER
        else { // Logic to HIDE viewer
            // ... (ensure this part remains correct as it was)
            console.log('[OTK Viewer] toggleViewer: Attempting to HIDE viewer.');
            viewer.style.paddingTop = '10px'; // Reset to default padding
            viewer.style.paddingLeft = '20px';
            viewer.style.paddingRight = '20px';
            viewer.style.paddingBottom = '10px';
            viewer.style.display = 'none';
            document.body.style.overflow = originalBodyOverflow;

            otherBodyNodes.forEach(item => {
                item.node.style.display = item.originalDisplay;
            });
            otherBodyNodes = [];

            if (bar) { // 'bar' is already defined
                bar.style.zIndex = '9999';
            }
            if (embedObserver) {
                console.log('[OTK Viewer IO] Disconnecting IntersectionObserver as viewer is hidden.');
                embedObserver.disconnect();
            }
            localStorage.setItem('otkViewerVisible', 'false');
        }
    }

    // Listen for toggle event from thread tracker script
    window.addEventListener('otkToggleViewer', toggleViewer);

    // Auto-open viewer if it was visible before refresh
    const viewerWasVisible = localStorage.getItem('otkViewerVisible');
    console.log('[OTK Viewer] Init: viewerWasVisible from localStorage:', viewerWasVisible);
    const initialSelectedId = localStorage.getItem(SELECTED_MESSAGE_KEY); // Assuming SELECTED_MESSAGE_KEY is 'otkSelectedMessageId'
    console.log('[OTK Viewer] Init: initialSelectedId from localStorage:', initialSelectedId);
    if (viewerWasVisible === 'true') {
        console.log('[OTK Viewer EXECUTION] Initial load: viewerWasVisible is true, calling toggleViewer.');
        toggleViewer();
    }

    // Handle page visibility changes
    function handleVisibilityChange() {
        if (document.visibilityState === 'visible') {
            if (viewer && viewer.style.display === 'block') {
                console.log('[OTK Viewer Scroll] Visibility changed to visible, managing initial scroll.');
                manageInitialScroll();
            }
        }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    window.addEventListener('otkMessagesUpdated', () => {
        console.log('[OTK Viewer EXECUTION] Event: otkMessagesUpdated received.');
        if (viewer.style.display === 'block') {
            // const lastScrollTop = viewer.scrollTop; // Not needed in the same way
            console.log('[OTK Viewer Scroll] Messages updated, re-rendering and managing scroll.');
            activeThreads = JSON.parse(localStorage.getItem(THREADS_KEY)) || [];
            messagesByThreadId = JSON.parse(localStorage.getItem(MESSAGES_KEY)) || {};
            threadColors = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
            renderAllMessages(); // This will internally call manageInitialScroll
            // The new manageInitialScroll should handle restoring to selected or lastScrolled.
            // If neither, it scrolls to bottom. If user was at a specific scroll position
            // that wasn't explicitly saved as lastScrolledId, that position *will* be lost.
            // This is a change from previous behavior of trying to restore raw scrollTop.
            // The new behavior is generally more robust.
        }
    });

})();
