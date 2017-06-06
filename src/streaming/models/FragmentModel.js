/* jshint unused: false */
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

import EventBus from '../../core/EventBus';
import Events from '../../core/events/Events';
import FactoryMaker from '../../core/FactoryMaker';
import FragmentRequest from '../vo/FragmentRequest';
import Debug from '../../core/Debug';

const FRAGMENT_MODEL_LOADING = 'loading';
const FRAGMENT_MODEL_EXECUTED = 'executed';
const FRAGMENT_MODEL_CANCELED = 'canceled';
const FRAGMENT_MODEL_FAILED = 'failed';

function FragmentModel(config) {

    const context = this.context;
    const log = Debug(context).getInstance().log;
    const eventBus = EventBus(context).getInstance();
    const metricsModel = config.metricsModel;

    let instance,
        scheduleController,
        executedRequests,
        loadingRequests,
        fragmentLoader,
        slidingDataWindow;

    function setup() {
        scheduleController = null;
        fragmentLoader = null;
        executedRequests = [];
        loadingRequests = [];
        slidingDataWindow = {
            video: new Uint8Array(),
            audio: new Uint8Array()
        };
        eventBus.on(Events.LOADING_COMPLETED, onLoadingCompleted, instance);
        eventBus.on(Events.LOADING_PROGRESS, onLoadingProgress, instance);
    }

    function setLoader(value) {
        fragmentLoader = value;
    }

    function isFragmentLoaded(request) {
        const isEqualComplete = function (req1, req2) {
            return ((req1.action === FragmentRequest.ACTION_COMPLETE) && (req1.action === req2.action));
        };

        const isEqualMedia = function (req1, req2) {
            return !isNaN(req1.index) && (req1.startTime === req2.startTime) && (req1.adaptationIndex === req2.adaptationIndex);
        };

        const isEqualInit = function (req1, req2) {
            return isNaN(req1.index) && isNaN(req2.index) && (req1.quality === req2.quality);
        };

        const check = function (requests) {
            let isLoaded = false;
            requests.some( req => {
                if (isEqualMedia(request, req) || isEqualInit(request, req) || isEqualComplete(request, req)) {
                    isLoaded = true;
                    return isLoaded;
                }
            });
            return isLoaded;
        };

        return check(executedRequests);
    }

    /**
     *
     * Gets an array of {@link FragmentRequest} objects
     *
     * @param {Object} filter The object with properties by which the method filters the requests to be returned.
     *  the only mandatory property is state, which must be a value from
     *  other properties should match the properties of {@link FragmentRequest}. E.g.:
     *  getRequests({state: FragmentModel.FRAGMENT_MODEL_EXECUTED, quality: 0}) - returns
     *  all the requests from executedRequests array where requests.quality = filter.quality
     *
     * @returns {Array}
     * @memberof FragmentModel#
     */
    function getRequests(filter) {

        const states = filter.state instanceof Array ? filter.state : [filter.state];

        let filteredRequests = [];
        states.forEach( state => {
            const requests = getRequestsForState(state);
            filteredRequests = filteredRequests.concat(filterRequests(requests, filter));
        });

        return filteredRequests;
    }

    function removeExecutedRequestsBeforeTime(time) {
        executedRequests = executedRequests.filter( req => isNaN(req.startTime) || req.startTime >= time );
    }

    function abortRequests() {
        fragmentLoader.abort();
        loadingRequests = [];
    }

    function executeRequest(request) {

        switch (request.action) {
            case FragmentRequest.ACTION_COMPLETE:
                executedRequests.push(request);
                addSchedulingInfoMetrics(request, FRAGMENT_MODEL_EXECUTED);
                eventBus.trigger(Events.STREAM_COMPLETED, {request: request, fragmentModel: this});
                break;
            case FragmentRequest.ACTION_DOWNLOAD:
                addSchedulingInfoMetrics(request, FRAGMENT_MODEL_LOADING);
                loadingRequests.push(request);
                loadCurrentFragment(request);
                break;
            default:
                log('Unknown request action.');
        }
    }

    function loadCurrentFragment(request) {
        eventBus.trigger(Events.FRAGMENT_LOADING_STARTED, {sender: instance, request: request});
        fragmentLoader.load(request);
    }

    function getRequestForTime(arr, time, threshold) {
        // loop through the executed requests and pick the one for which the playback interval matches the given time
        const lastIdx = arr.length - 1;
        for (let i = lastIdx; i >= 0; i--) {
            const req = arr[i];
            const start = req.startTime;
            const end = start + req.duration;
            threshold = threshold !== undefined ? threshold : (req.duration / 2);
            if ((!isNaN(start) && !isNaN(end) && ((time + threshold) >= start) && ((time - threshold) < end)) || (isNaN(start) && isNaN(time))) {
                return req;
            }
        }
        return null;
    }

    function filterRequests(arr, filter) {
        // for time use a specific filtration function
        if (filter.hasOwnProperty('time')) {
            return [getRequestForTime(arr, filter.time, filter.threshold)];
        }

        return arr.filter(request => {
            for (const prop in filter) {
                if (prop === 'state') continue;
                if (filter.hasOwnProperty(prop) && request[prop] != filter[prop]) return false;
            }

            return true;
        });
    }

    function getRequestsForState(state) {

        let requests;
        switch (state) {
            case FRAGMENT_MODEL_LOADING:
                requests = loadingRequests;
                break;
            case FRAGMENT_MODEL_EXECUTED:
                requests = executedRequests;
                break;
            default:
                requests = [];
        }
        return requests;
    }

    function addSchedulingInfoMetrics(request, state) {

        metricsModel.addSchedulingInfo(
            request.mediaType,
            new Date(),
            request.type,
            request.startTime,
            request.availabilityStartTime,
            request.duration,
            request.quality,
            request.range,
            state);

        metricsModel.addRequestsQueue(request.mediaType, loadingRequests, executedRequests);
    }

    function onLoadingCompleted(e) {
        if (e.sender !== fragmentLoader) return;
        loadingRequests.splice(loadingRequests.indexOf(e.request), 1);
        if (e.response && !e.error) {
            executedRequests.push(e.request);
        }
        addSchedulingInfoMetrics(e.request, e.error ? FRAGMENT_MODEL_FAILED : FRAGMENT_MODEL_EXECUTED);
        log('Loading of `' + e.request.url + '\' completed.');
        let type = e.request.mediaType;
        let chunk;
        [chunk, slidingDataWindow[type]] = [slidingDataWindow[type], new (slidingDataWindow[type]).constructor()];
        if (0 < chunk.length) {
            eventBus.trigger(Events.FRAGMENT_LOADING_COMPLETED, {
                request: e.request,
                response: chunk,
                sender: this
            });
        }
    }

    function concat(a, b) {
        let c = (new a.constructor(a.length + b.length));
        c.set(a);
        c.set(b, a.length);
        return c;
    }

    const headChunk = (function (nameDecoder, legalBoxNames, endOfChunkBoxNames) {
        const boxSize = (d) => d[3] + ((d[2] << 8) >>> 0) + ((d[1] << 16) >>> 0) + ((d[0] << 24) >>> 0);
        const boxName = (data) => nameDecoder.decode(data.slice(4,8));
        const legalBox = (data) => legalBoxNames.includes(boxName(data));
        const endOfChunk = (data) => endOfChunkBoxNames.includes(boxName(data));
        function headBox(data) {
            let end = 0;
            if (8 <= data.length) {
                if (!legalBox(data)) throw new Error('`' + boxName(data) + '\' is not a legal MP4 box name.');
                end = boxSize(data) > data.length ? 0 : boxSize(data);
            }
            return [data.slice(0,end), data.slice(end)];
        }
        // We actually only want the chunk if it has been completely loaded, thus the repeated concat calls are
        // inefficient if the chunk has not yet been fully loaded. Improve by preemptively ensuring that a whole chunk
        // is available.
        return function (data) {
            let chunk = new data.constructor();
            while (0 < data.length) {
                let box;
                [box, data] = headBox(data);
                if (0 === box.length) break;
                chunk = concat(chunk,box);
                if (endOfChunk(box)) {
                    return [chunk, data];
                }
            }
            return [new data.constructor(), concat(chunk, data)];
        };
    })(new TextDecoder('utf-8'), ['ftyp','moov','styp','moof','skip','mdat'], ['moov', 'mdat']);

    function onLoadingProgress(e) {
        if (e.sender !== fragmentLoader) return;
        let type = e.request.mediaType;
        if (e.response) {
            // let chunk;
            slidingDataWindow[type] = concat(slidingDataWindow[type], e.response);
            // [chunk, slidingDataWindow[type]] = headChunk(slidingDataWindow[type]);
            // if (0 < chunk.length) {
            //     eventBus.trigger(Events.FRAGMENT_LOADING_COMPLETED, {
            //         request: e.request,
            //         response: chunk.buffer,
            //         sender: this
            //     });
            // }
        }
    }

    function reset() {
        eventBus.off(Events.LOADING_COMPLETED, onLoadingCompleted, this);
        eventBus.off(Events.LOADING_PROGRESS, onLoadingProgress, this);

        if (fragmentLoader) {
            fragmentLoader.reset();
            fragmentLoader = null;
        }

        executedRequests = [];
        loadingRequests = [];
    }

    instance = {
        setLoader: setLoader,
        getRequests: getRequests,
        isFragmentLoaded: isFragmentLoaded,
        removeExecutedRequestsBeforeTime: removeExecutedRequestsBeforeTime,
        abortRequests: abortRequests,
        executeRequest: executeRequest,
        reset: reset
    };

    setup();
    return instance;
}

FragmentModel.__dashjs_factory_name = 'FragmentModel';
const factory = FactoryMaker.getClassFactory(FragmentModel);
factory.FRAGMENT_MODEL_LOADING = FRAGMENT_MODEL_LOADING;
factory.FRAGMENT_MODEL_EXECUTED = FRAGMENT_MODEL_EXECUTED;
factory.FRAGMENT_MODEL_CANCELED = FRAGMENT_MODEL_CANCELED;
factory.FRAGMENT_MODEL_FAILED = FRAGMENT_MODEL_FAILED;
export default factory;
