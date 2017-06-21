/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
/**
 * Created by robert on 2017-05-10.
 */
/* global Headers: false, ProgressEvent: false */

import {HTTPRequest} from './vo/metrics/HTTPRequest';
import FactoryMaker from '../core/FactoryMaker';
import MediaPlayerModel from './models/MediaPlayerModel';
import ErrorHandler from './utils/ErrorHandler.js';
import Debug from '../core/Debug';

/**
 * @module FetchLoader
 * @description Manages download of resources via HTTP.
 * @param {Object} cfg - dependancies from parent
 */
function FetchLoader(cfg) {
    const context = this.context;

    const log = Debug(context).getInstance().log;
    const warn = window.console.warn;
    const mediaPlayerModel = MediaPlayerModel(context).getInstance();

    const errHandler = cfg.errHandler;
    const metricsModel = cfg.metricsModel;
    const requestModifier = cfg.requestModifier;

    let retryTimers = [];
    const downloadErrorToRequestTypeMap = {
        [HTTPRequest.MPD_TYPE]:                         ErrorHandler.DOWNLOAD_ERROR_ID_MANIFEST,
        [HTTPRequest.XLINK_EXPANSION_TYPE]:             ErrorHandler.DOWNLOAD_ERROR_ID_XLINK,
        [HTTPRequest.INIT_SEGMENT_TYPE]:                ErrorHandler.DOWNLOAD_ERROR_ID_INITIALIZATION,
        [HTTPRequest.MEDIA_SEGMENT_TYPE]:               ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
        [HTTPRequest.INDEX_SEGMENT_TYPE]:               ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
        [HTTPRequest.BITSTREAM_SWITCHING_SEGMENT_TYPE]: ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
        [HTTPRequest.OTHER_TYPE]:                       ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT
    };

    function internalLoad(config, remainingAttempts) {
        let request = config.request;

        function fetcher() {
            let traces = [];
            request.requestStartDate = new Date();

            const progress = (function () {
                const boxNameDecoder = new TextDecoder('utf-8');
                const legalBoxNames = ['ftyp','moov','styp','moof','skip','mdat'];
                const endOfChunkBoxNames = ['moov', 'mdat'];

                function boxSize(data) {
                    return new DataView(data.slice(0,4).buffer).getUint32(0,false);
                }

                function boxName(data) {
                    return boxNameDecoder.decode(data.subarray(4, 8));
                }

                function legalBox(data) {
                    return legalBoxNames.includes(boxName(data));
                }

                function endOfChunk(data) {
                    return endOfChunkBoxNames.includes(boxName(data));
                }

                function headBox(data) {
                    let end = 0;
                    if (8 <= data.length) {
                        if (legalBox(data)) {
                            let size = boxSize(data);
                            end = size > data.length ? 0 : size;
                        } else {
                            throw new Error('`' + boxName(data) + '\' is not a legal MP4 box name.');
                        }
                    }
                    return [data.subarray(0,end), data.subarray(end)];
                }

                function headChunk(data) {
                    let end = 0;
                    while (true) {
                        let box = headBox(data.subarray(end))[0];
                        if (0 < box.length) { // append box to chunk
                            end += box.length;
                            if (endOfChunk(box)) break;
                        } else { // no box was extracted, but chunk isn't done yet
                            end = 0;
                            break;
                        }
                    }
                    return [data.subarray(0,end), data.subarray(end)];
                }

                function concat(a, b) {
                    let c = new a.constructor(a.length + b.length);
                    c.set(a);
                    c.set(b, a.length);
                    return c;
                }

                let slidingData = new Uint8Array();
                let [firstProgress, firstChunkLoaded] = [true, false];
                let [lastTraceDate, lastTraceReceivedCount] = [request.requestStartDate, 0];

                return function progress(event, newData) {
                    const currentDate = new Date();
                    let data = newData ? concat(slidingData, newData) : slidingData;
                    if (firstProgress) {
                        firstProgress = false;
                        request.firstByteDate = currentDate;
                    }
                    if (!firstChunkLoaded) {
                        // If the segment is loaded partially (BaseURL.availabilityTimeComplete is false), subsequent
                        // loads must not be accounted for in bandwidth estimation! Should also be feasible for complete
                        // segments.
                        traces.push({
                            s: lastTraceDate,
                            d: currentDate - lastTraceDate,
                            b: [event.loaded ? event.loaded - lastTraceReceivedCount : 0]
                        });
                    }
                    for (let chunk; [chunk, data] = headChunk(data), (0 < chunk.length); ) {
                        log(request.mediaType, request.startTime, 'progress (' + chunk.length + ' bytes) after',
                            ((new Date() - request.requestStartDate) * 0.001).toFixed(2), 'seconds.');
                        if (!firstChunkLoaded) {
                            firstChunkLoaded = true;
                            request.requestEndDate = currentDate;
                        }
                        if (config.progress) {
                            config.progress(chunk);
                        }
                    }
                    if (event.lengthComputable) {
                        request.bytesLoaded = event.loaded;
                        request.bytesTotal = event.total;
                    }
                    slidingData = data;
                    lastTraceDate = currentDate;
                    lastTraceReceivedCount = event.loaded;
                };
            })();

            fetch(requestModifier.modifyRequestURL(request.url), (() => {
                let headers = new Headers();
                if (request.range) {
                    headers.append('Range', 'bytes=' + request.range);
                }
                return {
                    method: request.checkForExistenceOnly ? 'HEAD' : 'GET',
                    headers: headers,
                    mode: mediaPlayerModel.getXHRWithCredentialsForType(request.type)
                };
            })()).then(({status, statusText, url, headers, body}) => {
                progress(new ProgressEvent('loadstart'));
                let headersString = '';
                for (const pair of headers) {
                    headersString += pair[0] + ': ' + pair[1] + '\r\n';
                }
                headersString = headersString.length > 0 ? headersString : null;
                return {
                    url: url,
                    status: status,
                    statusText: statusText,
                    headers: headersString,
                    reader: body.getReader()
                };
            }).then(({url, status, statusText, headers, reader}) => {
                let loaded = 0;
                const consume = ({value, done}) => {
                    if (done) {
                        return {
                            url: url,
                            status: status,
                            statusText: statusText,
                            headers: headers,
                            loaded: loaded
                        };
                    }
                    loaded += value.length;
                    progress(new ProgressEvent('progress', {loaded: loaded}), value);
                    return reader.read().then(consume);
                };
                return reader.read().then(consume);
            }).then(({url, status, statusText, headers, loaded}) => {
                let success = false;
                if (status >= 200 && status <= 299) {
                    progress(new ProgressEvent('load', {
                        lengthComputable: true,
                        loaded: loaded,
                        total: loaded
                    }));
                    success = true;
                    if (config.success) {
                        config.success();
                    }
                    if (config.complete) {
                        config.complete(request, statusText);
                    }
                } else {
                    progress(new ProgressEvent('error'));
                    if (remainingAttempts > 0) {
                        remainingAttempts--;
                        retryTimers.push(setTimeout(function () {
                            internalLoad(config, remainingAttempts);
                        }, mediaPlayerModel.getRetryIntervalForType(request.type)));
                    } else {
                        errHandler.downloadError(downloadErrorToRequestTypeMap[request.type], request.url, request);
                        if (config.error) {
                            config.error(request, statusText);
                        }
                        if (config.complete) {
                            config.complete(request, statusText);
                        }
                    }
                }
                progress(new ProgressEvent('loadend'));
                if (!request.checkForExistenceOnly) {
                    metricsModel.addHttpRequest(
                        request.mediaType,
                        null,
                        request.type,
                        request.url,
                        url || null,
                        request.serviceLocation || null,
                        request.range || null,
                        request.requestStartDate,
                        request.firstByteDate,
                        request.requestEndDate,
                        status,
                        request.duration,
                        headers,
                        success ? traces : null
                    );
                }
            }).catch((error) => {
                log(error.message);
            });

        }


        // Adds the ability to delay single fragment loading time to control buffer.
        let now = new Date().getTime();
        if (isNaN(request.delayLoadingTime) || now >= request.delayLoadingTime) {
            fetcher();
        } else {
            // Can keep track of timeouts and abort them before they are dispatched!
            setTimeout(fetcher, (request.delayLoadingTime - now));
        }
    }

    /**
     * Initiates a download of the resource described by config.request
     * @param {Object} config - contains request (FragmentRequest or derived type), and callbacks
     * @memberof module:FetchLoader
     * @instance
     */
    function load(config) {
        if (config.request) {
            internalLoad(
                config,
                mediaPlayerModel.getRetryAttemptsForType(
                    config.request.type
                )
            );
        }
    }

    /**
     * Aborts any inflight downloads
     * @memberof module:FetchLoader
     * @instance
     */
    function abort() {
        // Need to assure that downloads in progress are disposed, even if we can't properly abort them
        warn(abort.name, 'is not implemented.');
    }

    return {
        load: load,
        abort: abort
    };
}

FetchLoader.__dashjs_factory_name = 'FetchLoader';

const factory = FactoryMaker.getClassFactory(FetchLoader);
export default factory;
