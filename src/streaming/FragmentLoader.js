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

import FetchLoader from './FetchLoader';
import HeadRequest from './vo/HeadRequest';
import Error from './vo/Error';
import EventBus from './../core/EventBus';
import Events from './../core/events/Events';
import FactoryMaker from '../core/FactoryMaker';
import Debug from '../core/Debug';

const FRAGMENT_LOADER_ERROR_LOADING_FAILURE = 1;
const FRAGMENT_LOADER_ERROR_NULL_REQUEST = 2;

function FragmentLoader(config) {

    const context = this.context;
    const eventBus = EventBus(context).getInstance();
    const log = Debug(context).getInstance().log;
    const assert = window.console.assert;

    let instance,
        loader,
        slidingDataWindow;

    function setup() {
        loader = FetchLoader(context).create({
            errHandler: config.errHandler,
            metricsModel: config.metricsModel,
            requestModifier: config.requestModifier
        });
        slidingDataWindow = new Map();
    }

    function checkForExistence(request) {
        if (request) {
            let headRequest = new HeadRequest(request.url);
            loader.load({
                request: headRequest,
                success: function () {
                    eventBus.trigger(Events.CHECK_FOR_EXISTENCE_COMPLETED, {
                        request: request,
                        exists: true
                    });
                },
                error: function () {
                    eventBus.trigger(Events.CHECK_FOR_EXISTENCE_COMPLETED, {
                        request: request,
                        exists: false
                    });
                }
            });
        } else {
            eventBus.trigger(Events.CHECK_FOR_EXISTENCE_COMPLETED, {
                request: request,
                exists: false
            });
        }
    }

    const boxSize = (data) => (new DataView(data.slice(0,4).buffer)).getUint32(0,false);

    const boxName = (function (nameDecoder) {
        return (data) => nameDecoder.decode(data.subarray(4, 8));
    })(new TextDecoder('utf-8'));

    const legalBox = (function (legalBoxNames) {
        return (data) => legalBoxNames.includes(boxName(data));
    })(['ftyp','moov','styp','moof','skip','mdat']);

    const endOfChunk = (function (endOfChunkBoxNames) {
        return (data) => endOfChunkBoxNames.includes(boxName(data));
    })(['moov', 'mdat']);

    function headBox(data) {
        let end = 0;
        if (8 <= data.length) {
            if (!legalBox(data)) throw new Error('`' + boxName(data) + '\' is not a legal MP4 box name.');
            end = boxSize(data) > data.length ? 0 : boxSize(data);
        }
        return [data.subarray(0,end), data.subarray(end)];
    }

    // function headChunk(data) {
    //     let [chunk, box, rest] = [data.subarray(0,0), data.subarray(0,0), data.subarray(0)];
    //     while (true) {
    //         [box, rest] = headBox(rest);
    //         if (0 < box.length) { // append box to chunk
    //             let [end, done] = [chunk.length + box.length, endOfChunk(box)];
    //             [chunk, box] = [data.subarray(0, end), data.subarray(end, 0)];
    //             if (done) break;
    //         } else { // no box was extracted, but chunk isn't done yet
    //             [chunk, rest] = [data.subarray(0,0), data.subarray(0)];
    //             break;
    //         }
    //     }
    //     assert([chunk, rest].map(a => a.length).reduce((a, b) => a + b, 0) === data.length);
    //     return [chunk, rest];
    // }

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

    function load(request) {
        if (request) {
            loader.load({
                request: request,
                progress: function (response) {
                    if (response) {
                        let data = concat(slidingDataWindow.get(request.url) || new Uint8Array(), response);
                        for (let chunk; [chunk, data] = headChunk(data), (0 < chunk.length); ) {
                            log(request.mediaType, request.startTime, 'progress (' + chunk.length + ' bytes) after',
                                ((new Date() - request.requestStartDate) * 0.001).toFixed(2), 'seconds.');
                            eventBus.trigger(Events.LOADING_PROGRESS, {
                                request: request,
                                response: chunk,
                                error: null,
                                sender: instance
                            });
                        }
                        slidingDataWindow.set(request.url, data);
                    }
                },
                success: function () {
                    let data = slidingDataWindow.get(request.url);
                    assert([headChunk, headBox, boxName, boxSize]); // Hack to work around optimization while debugging
                    assert(0 === data.length);
                    slidingDataWindow.delete(request.url);
                    log(request.mediaType, request.startTime, 'success.');
                    eventBus.trigger(Events.LOADING_COMPLETED, {
                        request: request,
                        response: null,
                        error: null,
                        sender: instance
                    });
                },
                error: function (request, statusText) {
                    eventBus.trigger(Events.LOADING_COMPLETED, {
                        request: request,
                        response: null,
                        error: new Error(FRAGMENT_LOADER_ERROR_LOADING_FAILURE, 'Loading failure.', statusText),
                        sender: instance
                    });
                }
            });
        } else {
            eventBus.trigger(Events.LOADING_COMPLETED, {
                request: request,
                response: null,
                error: new Error(FRAGMENT_LOADER_ERROR_NULL_REQUEST, 'Missing request.'),
                sender: instance
            });
        }
    }

    function abort() {
        if (loader) {
            loader.abort();
        }
    }

    function reset() {
        if (loader) {
            loader.abort();
            loader = null;
        }
    }

    instance = {
        checkForExistence: checkForExistence,
        load: load,
        abort: abort,
        reset: reset
    };

    setup();

    return instance;
}

FragmentLoader.__dashjs_factory_name = 'FragmentLoader';

const factory = FactoryMaker.getClassFactory(FragmentLoader);
factory.FRAGMENT_LOADER_ERROR_LOADING_FAILURE = FRAGMENT_LOADER_ERROR_LOADING_FAILURE;
factory.FRAGMENT_LOADER_ERROR_NULL_REQUEST = FRAGMENT_LOADER_ERROR_NULL_REQUEST;
export default factory;
