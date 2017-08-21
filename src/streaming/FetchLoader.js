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
import ISOBoxer from 'codem-isoboxer';
/* global Headers: false */

/**
 * @module FetchLoader
 * @description Manages download of resources via HTTP.
 * @param {Object} cfg - dependencies from parent
 */
const FetchLoader = function (cfg) {
    const context = this.context;

    const log = Debug(context).getInstance().log;

    const errHandler = cfg.errHandler;
    const metricsModel = cfg.metricsModel;
    const mediaPlayerModel = cfg.mediaPlayerModel;
    const requestModifier = cfg.requestModifier;

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

    const internalLoad = function (config, remainingAttempts) {
        let request = config.request;

        const fetcher = (function () {
            let traces = [];
            request.requestStartDate = new Date();

            const progress = (function () {
                let then;
                let remaining = new Uint8Array();
                let pushedOnce = false;

                /**
                 * @param {TypedArray} a
                 * @param {TypedArray} b
                 * @returns {TypedArray} New array consisting of the elements of <code>a</code>, followed by the
                 * elements of <code>b</code>.
                 */
                const concatTypedArray = function (a, b) {
                    if (a.constructor !== b.constructor) {
                        throw new TypeError('Type mismatch. Expected: ' + a.constructor.name +
                            ', but got: ' + b.constructor.name + '.');
                    }
                    let c = new a.constructor(a.length + b.length);
                    c.set(a);
                    c.set(b, a.length);
                    return c;
                };

                /**
                 * @param {TypedArray} data
                 * @returns {TypedArray []} Tuple containing completed CMAF chunks and the remaining data.
                 */
                const getReady = function (data) {
                    let boxes = ISOBoxer.parseBuffer(data.buffer).boxes;
                    let end = 0;
                    for (let i = 0; i < boxes.length; i++) {
                        if (boxes[i]._incomplete) {
                            break;
                        } else if (['moov', 'mdat'].includes(boxes[i].type)) {
                            end = boxes[i]._offset + boxes[i].size;
                        }
                    }
                    return [data.subarray(0, end), data.subarray(end)];
                };

                /**
                 * Loading progress parsing and reporting.
                 * @param {Uint8Array} progress
                 */
                return function (progress) {
                    let now = new Date();
                    then = then || now;
                    let ready;
                    [ready, remaining] = getReady(concatTypedArray(remaining, progress));
                    if (0 < ready.length) {
                        if (!pushedOnce) {
                            traces.push({
                                s: then,
                                d: now - then,
                                b: [ready.length]
                            });
                            pushedOnce = true;
                        }
                        then = (0 < remaining.length) ? now : undefined;
                        if (config.progress) {
                            config.progress(ready);
                        }
                    }
                };
            })();

            /**
             * Fetch resource specified by <code>config.request</code>.
             */
            return function () {
                fetch(requestModifier.modifyRequestURL(request.url), (function () {
                    let headers = new Headers();
                    if (request.range) {
                        headers.append('Range', 'bytes=' + request.range);
                    }
                    return {
                        method: request.checkForExistenceOnly ? 'HEAD' : 'GET',
                        headers: headers,
                        mode: mediaPlayerModel.getXHRWithCredentialsForType(request.type)
                    };
                })()).then(function ({status, statusText, url, headers, body}) {
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
                    const consume = function ({value, done}) {
                        if (done) {
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
                        progress(value);
                        return reader.read().then(consume);
                    };
                    return reader.read().then(consume);
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
        })();


        // Adds the ability to delay single fragment loading time to control buffer.
        let now = new Date().getTime();
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
