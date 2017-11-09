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

import {HTTPRequest} from './vo/metrics/HTTPRequest';
import FactoryMaker from '../core/FactoryMaker';
import ErrorHandler from './utils/ErrorHandler.js';
import Debug from '../core/Debug';
import {concat} from './utils/TypedArray';
import {parse} from './utils/CMAFChunk';
/* global Headers: false */

const ChunkProcessor = function ({config, traces, throughputHistory}) {
    const log = Debug().getInstance().log;
    const request = config.request;
    const mediaType = request.mediaType;

    let now = config.requestStartDate;
    let then;

    let firstChunkLoaded = false;
    let recordAllChunks = false;
    let maxHistory = 1;
    let remaining = new Uint8Array();

    const process = function (completed) {
        // Throughput estimation should be done by ThrouhputHistory which needs modification to account for chunks.
        let [bits, milliseconds] = [8 * completed.length, now - then];
        if (recordAllChunks || !firstChunkLoaded) {
            firstChunkLoaded = true;
            throughputHistory[mediaType].push({
                bits: bits,
                milliseconds: milliseconds || 1  // Avoid Infinity
            });
            if (maxHistory < throughputHistory[mediaType].length) {
                throughputHistory[mediaType].shift();
            }
        }
        let [totalBits, totalMilliseconds] = throughputHistory[mediaType].reduce((acc, {bits, milliseconds}) => [acc[0] + bits, acc[1] + milliseconds], [0,0]);
        let throughput = totalBits / totalMilliseconds;
        log('livestat', 'chunk loading completed in:', (milliseconds / 1000).toFixed(3), mediaType, 'throughput:', throughput.toFixed(0));

        traces.push({
            s: then,
            d: milliseconds,
            b: [completed.length]
        });
        then = (0 < remaining.length) ? now : undefined;
        if (config.progress) {
            // Need outgoing data to be of type ArrayBuffer for compatibility, unfortunately have to reallocate the ArrayBuffer
            config.progress(completed.slice().buffer);
        }
    };

    return {
        process: process
    };
};


/**
 * @module FetchLoader
 * @description Manages download of resources via HTTP.
 * @param {Object} object
 */
const FetchLoader = function ({errHandler, metricsModel, mediaPlayerModel, requestModifier}) {
    const context = this.context;

    const log = Debug(context).getInstance().log;

    const downloadErrorToRequestTypeMap = {
        [HTTPRequest.MPD_TYPE]:                         ErrorHandler.DOWNLOAD_ERROR_ID_MANIFEST,
        [HTTPRequest.XLINK_EXPANSION_TYPE]:             ErrorHandler.DOWNLOAD_ERROR_ID_XLINK,
        [HTTPRequest.INIT_SEGMENT_TYPE]:                ErrorHandler.DOWNLOAD_ERROR_ID_INITIALIZATION,
        [HTTPRequest.MEDIA_SEGMENT_TYPE]:               ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
        [HTTPRequest.INDEX_SEGMENT_TYPE]:               ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
        [HTTPRequest.BITSTREAM_SWITCHING_SEGMENT_TYPE]: ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT,
        [HTTPRequest.OTHER_TYPE]:                       ErrorHandler.DOWNLOAD_ERROR_ID_CONTENT
    };

    let retryTimers = [];
    let throughputHistory = {'audio': [], 'video': []};

    const internalLoad = function (config, remainingAttempts) {
        let request = config.request;
        let traces = [];
        let now = new Date();
        request.requestStartDate = now;

        const {process} = ChunkProcessor({config: config, traces: traces, throughputHistory: throughputHistory});
        const url = requestModifier.modifyRequestURL(request.url);
        const method = request.checkForExistenceOnly ? 'HEAD' : 'GET';
        const headers = new Headers(request.range ? { 'Range': 'bytes=' + request.range } : undefined);
        const mode = mediaPlayerModel.getXHRWithCredentialsForType(request.type);

        const fetcher = function () {
            fetch(url, {
                method: method,
                headers: headers,
                mode: mode
            }).then(function ({status, statusText, url, headers, body}) {
                request.firstByteDate = new Date();
                let headersString = '';
                headers.forEach((key, value) => headersString += key + ': ' + value + '\r\n');
                headersString = headersString.length > 0 ? headersString : null;
                return {
                    url: url,
                    status: status,
                    statusText: statusText,
                    headers: headersString,
                    reader: body.getReader()
                };
            }).then(function ({url, status, statusText, headers, reader}) {
                request.bytesLoaded = 0;
                let remaining = new Uint8Array();
                const eat = function ({value, done}) {
                    if (done) {
                        if (0 < remaining.length) process(remaining);
                        request.requestEndDate = new Date();
                        request.bytesTotal = request.bytesLoaded;
                        return {
                            url: url,
                            status: status,
                            statusText: statusText,
                            headers: headers
                        };
                    }
                    request.bytesLoaded += value.length;
                    const progress = concat(remaining, value);
                    let completed = [];
                    if (HTTPRequest.MEDIA_SEGMENT_TYPE === request.type) {
                        [remaining, ...completed] = parse(progress).reverse();
                    } else {
                        remaining = progress;
                    }
                    completed.reverse().forEach(process);
                    return reader.read().then(eat);
                };
                return reader.read().then(eat);
            }).then(function ({url, status, statusText, headers}) {
                let success = status >= 200 && status <= 299;
                if (success) {
                    if (config.success) {
                        config.success();
                    }
                    if (config.complete) {
                        config.complete(undefined, statusText);
                    }
                } else {
                    if (remainingAttempts > 0) {
                        remainingAttempts--;
                        retryTimers.push(setTimeout(function () {
                            internalLoad(config, remainingAttempts);
                        }, mediaPlayerModel.getRetryIntervalForType(request.type)));
                    } else {
                        errHandler.downloadError(downloadErrorToRequestTypeMap[request.type], request.url, request);
                        if (config.error) {
                            config.error(undefined, statusText, 'no attempts remaining');
                        }
                        if (config.complete) {
                            config.complete(undefined, statusText);
                        }
                    }
                }
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
                let timePassed = (request.requestEndDate - request.requestStartDate) / 1000;
                log('livestat', 'loadend',
                    'index:', request.index,
                    'time passed:', timePassed.toFixed(3));
            }).catch(function (error) {
                log(error.message);
            });
        };


        // Adds the ability to delay single fragment loading time to control buffer.
        if (isNaN(request.delayLoadingTime) || now >= request.delayLoadingTime) {
            fetcher();
        } else {
            // Can keep track of timeouts and abort them before they are dispatched!
            setTimeout(fetcher, (request.delayLoadingTime - now));
        }
    };

    /**
     * Initiates a download of the resource described by config.request
     * @param {Object} config - contains request (FragmentRequest or derived type), and callbacks
     * @memberof module:FetchLoader
     * @instance
     */
    const load = function (config) {
        if (config.request) {
            internalLoad(config, mediaPlayerModel.getRetryAttemptsForType(config.request.type));
        }
    };

    /**
     * Aborts any inflight downloads
     * @memberof module:FetchLoader
     * @instance
     */
    const abort = function () {
        window.console.warn(abort.name, 'is not implemented.');
    };

    return {
        load: load,
        abort: abort
    };
};

FetchLoader.__dashjs_factory_name = 'FetchLoader';

const factory = FactoryMaker.getClassFactory(FetchLoader);
export default factory;
