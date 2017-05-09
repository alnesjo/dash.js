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
 * Created by robert on 2017-05-09.
 */
/* jshint esversion: 6 */
/* global Headers: false */

import Error from './vo/Error';
import EventBus from './../core/EventBus';
import Events from './../core/events/Events';
import FactoryMaker from '../core/FactoryMaker';

const FRAGMENT_LOADER_ERROR_LOADING_FAILURE = 1;
const FRAGMENT_LOADER_ERROR_NULL_REQUEST = 2;
const FRAGMENT_LOADER_MESSAGE_NULL_REQUEST = 'request is null';

function FragmentFetcher(config) {

    const context = this.context;
    const eventBus = EventBus(context).getInstance();
    const requestModifier = config.requestModifier;
    const mediaPlayerModel = config.mediaPlayerModel;

    let instance;

    function checkForExistence(request) {
        let headers = new Headers();
        if (request.responseType) {
            headers.append('Content-Type', request.responseType);
        }
        if (request.range) {
            headers.append('Range', 'bytes=' + request.range);
        }

        const report = function (success) {
            eventBus.trigger(
                Events.CHECK_FOR_EXISTENCE_COMPLETED, {
                    request: request,
                    exists: success
                }
            );
        };

        if (request) {
            fetch(requestModifier.modifyRequestURL(request.url), {
                method: 'HEAD',
                headers: headers,
                mode: mediaPlayerModel.getXHRWithCredentialsForType(request.type) ? 'cors' : 'no-cors'
            }).then(resp => {
                report(true);
            }).catch(error => {
                report(false);
            });
        } else {
            report(false);
        }
    }

    function load(request) {
        let headers = new Headers();
        if (request.responseType) {
            headers.append('Content-Type', request.responseType);
        }
        if (request.range) {
            headers.append('Range', 'bytes=' + request.range);
        }
        const report = function (data, error) {
            eventBus.trigger(Events.LOADING_COMPLETED, {
                request: request,
                response: data || null,
                error: error || null,
                sender: instance
            });
        };

        if (request) {
            let statusText;
            fetch(requestModifier.modifyRequestURL(request.url), {
                method: 'GET',
                headers: headers,
                mode: mediaPlayerModel.getXHRWithCredentialsForType(request.type) ? 'cors' : 'no-cors'
            }).then(response => {
                statusText = response.statusText;
                return response.body.getReader();
            }).then(reader => {
                const progress = ({value, done}) => {
                    if (done) { // end of stream
                        return;
                    }
                    eventBus.trigger(Events.LOADING_PROGRESS, {
                        request: request
                    });
                    eventBus.trigger(Events.LOADING_CHUNK, {
                        request: request,
                        response: value,
                        sender: instance
                    });
                    return reader.read().then(progress);
                };
                return reader.read().then(progress);
            }).then(data => {
                report(data);
            }).catch(error => {
                report(undefined, new Error(FRAGMENT_LOADER_ERROR_LOADING_FAILURE, error.message, statusText));
            });
        } else {
            report(undefined, new Error(FRAGMENT_LOADER_ERROR_NULL_REQUEST, FRAGMENT_LOADER_MESSAGE_NULL_REQUEST));
        }
    }

    function abort() {
    }

    function reset() {
    }

    instance = {
        checkForExistence: checkForExistence,
        load: load,
        abort: abort,
        reset: reset
    };

    return instance;
}

FragmentFetcher.__dashjs_factory_name = 'FragmentFetcher';

const factory = FactoryMaker.getClassFactory(FragmentFetcher);
factory.FRAGMENT_LOADER_ERROR_LOADING_FAILURE = FRAGMENT_LOADER_ERROR_LOADING_FAILURE;
factory.FRAGMENT_LOADER_ERROR_NULL_REQUEST = FRAGMENT_LOADER_ERROR_NULL_REQUEST;
export default factory;
