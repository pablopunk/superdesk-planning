import {get, cloneDeep, pickBy, has, every} from 'lodash';

import {IPlanningSearchParams} from '../../interfaces';
import {appConfig} from 'appConfig';

import * as actions from '../../actions';
import * as selectors from '../../selectors';
import {
    getErrorMessage,
    getTimeZoneOffset,
    planningUtils,
    lockUtils,
    isExistingItem,
    isPublishedItemId,
    isValidFileInput,
    gettext,
} from '../../utils';
import * as elastic from '../../utils/elastic';
import {
    PLANNING,
    POST_STATE,
    SPIKED_STATE,
    MAIN,
    WORKSPACE,
    TO_BE_CONFIRMED_FIELD,
} from '../../constants';
import main from '../main';
import {constructPlanningSearchQuery} from './search';

/**
 * Action dispatcher that marks a Planning item as spiked
 * @param {object} item - The planning item to spike
 * @return Promise
 */
const spike = (items) => (
    (dispatch, getState, {api}) => {
        let plansToSpike = (Array.isArray(items) ? items : [items]);

        return Promise.all(
            plansToSpike.map((plan) => (api.update('planning_spike', {...plan}, {})))
        ).then(
            () => Promise.resolve(plansToSpike),
            (error) => (Promise.reject(error))
        );
    }
);

/**
 * Action dispatcher that marks a Planning item as active
 * @param {object} item - The Planning item to unspike
 * @return Promise
 */
const unspike = (items) => (
    (dispatch, getState, {api}) => {
        let plansToSpike = (Array.isArray(items) ? items : [items]);

        return Promise.all(
            plansToSpike.map((plan) => (api.update('planning_unspike', {...plan}, {})))
        ).then(
            () => Promise.resolve(plansToSpike),
            (error) => (Promise.reject(error))
        );
    }
);

const cancel = (original, updates) => (
    (dispatch, getState, {api}) => (
        api.update(
            'planning_cancel',
            original,
            {reason: get(updates, 'reason', undefined)}
        )
    )
);

const cancelAllCoverage = (original, updates) => (
    (dispatch, getState, {api}) => (
        api.update(
            'planning_cancel',
            original,
            {
                reason: get(updates, 'reason', undefined),
                cancel_all_coverage: true,
            }
        )
    )
);

/**
 * Action dispatcher to perform fetch the list of planning items from the server.
 * @param {string} eventIds - An event ID to fetch Planning items for that event
 * @param {string} spikeState - Planning item's spiked state (SPIKED, NOT_SPIKED or BOTH)
 * @param {agendas} list of agenda ids
 * @param {int} page - The page number to query for
 * @return Promise
 */
const query = (
    {
        spikeState = SPIKED_STATE.BOTH,
        agendas,
        noAgendaAssigned = false,
        page = 1,
        advancedSearch = {},
        fulltext,
        maxResults = MAIN.PAGE_SIZE,
        adHocPlanning = false,
        excludeRescheduledAndCancelled = false,
        featured,
    }: IPlanningSearchParams,
    storeTotal = true,
    timeZoneOffset = null,
    includeScheduledUpdates = false

) => (
    (dispatch, getState, {api}) => {
        const sourceQuery = constructPlanningSearchQuery({
            spikeState: spikeState,
            agendas: agendas,
            noAgendaAssigned: noAgendaAssigned,
            advancedSearch: advancedSearch,
            fulltext: fulltext,
            adHocPlanning: adHocPlanning,
            excludeRescheduledAndCancelled: excludeRescheduledAndCancelled,
            startOfWeek: appConfig.start_of_week,
            featured: featured,
            timezoneOffset: timeZoneOffset ?? getTimeZoneOffset(),
            includeScheduledUpdates: includeScheduledUpdates,
        });

        // Query the API
        return api('planning').query({
            page: page,
            max_results: maxResults,
            source: JSON.stringify(sourceQuery),
            timestamp: new Date(),
        })
            .then((data) => {
                if (storeTotal) {
                    dispatch(main.setTotal(MAIN.FILTERS.PLANNING, data?._meta?.total ?? 0));
                }

                if (data?._items != null) {
                    data._items.forEach(planningUtils.modifyForClient);
                    if (selectors.featuredPlanning.inUse(getState()) &&
                        get(advancedSearch, 'dates.range') === MAIN.DATE_RANGE.FOR_DATE) {
                        // For featuredstories modal, we get all items in a loop
                        // So, send the total along with the result for loop calculation
                        const result = {
                            _items: data._items,
                            total: data._meta.total,
                        };

                        return Promise.resolve(result);
                    }

                    return Promise.resolve(data._items);
                } else {
                    return Promise.reject('Failed to retrieve items');
                }
            }, (error) => (Promise.reject(error)));
    }
);

/**
 * Action dispatcher for requesting a fetch of planning items
 * Then store them in the redux store. This also replaces the list of
 * visibile Planning items for the PlanningList component
 * @param {object} params - Parameters used when fetching the planning items
 * @return Promise
 */
const fetch = (params = {}) => (
    (dispatch) => (
        dispatch(self.query(params, true))
            .then((items) => (
                dispatch(self.fetchPlanningsEvents(items))
                    .then(() => {
                        dispatch(self.receivePlannings(items));
                        return Promise.resolve(items);
                    }, (error) => (Promise.reject(error)))
            ), (error) => {
                dispatch(self.receivePlannings([]));
                return Promise.reject(error);
            })
    )
);

/**
 * Action Dispatcher to re-fetch the current list of planning
 * It achieves this by performing a fetch using the params from
 * the store value `planning.lastRequestParams`
 */
const refetch = (page = 1, plannings = []) => (
    (dispatch, getState) => {
        const prevParams = selectors.main.lastRequestParams(getState());

        let params = {
            ...prevParams,
            page,
        };

        return dispatch(self.query(params, true))
            .then((items) => {
                plannings = plannings.concat(items); // eslint-disable-line no-param-reassign
                page++; // eslint-disable-line no-param-reassign
                if (get(prevParams, 'page', 1) >= page) {
                    return dispatch(self.refetch(page, plannings));
                }

                dispatch(self.receivePlannings(plannings));
                return Promise.resolve(plannings);
            }, (error) => (Promise.reject(error)));
    }
);

/**
 * Action dispatcher to fetch Events associated with Planning items
 * and place them in the local store.
 * @param {Array} plannings - An array of Planning items
 * @return Promise
 */
const fetchPlanningsEvents = (plannings) => (
    (dispatch, getState) => {
        const loadedEvents = selectors.events.storedEvents(getState());
        const linkedEvents = plannings
            .map((p) => p.event_item)
            .filter((eid) => (
                eid && !has(loadedEvents, eid)
            ));

        // load missing events, if there are any
        if (get(linkedEvents, 'length', 0) > 0) {
            return dispatch(actions.events.api.silentlyFetchEventsById(linkedEvents,
                SPIKED_STATE.BOTH));
        }

        return Promise.resolve([]);
    }
);

/**
 * Action Dispatcher that fetches a Planning Item by ID
 * and adds or updates it in the redux store.
 * If the Planning item already exists in the local store, then don't
 * fetch the Planning item from the API
 * @param {string} pid - The ID of the Planning item to fetch
 * @param {boolean} force - Force using the API instead of Redux store
 * @param {boolean} saveToStore - If true, save the Planning item in the Redux store
 * @param {boolean} loadEvents - If true, load associated Event item as well
 * @return Promise
 */
const fetchById = (pid, {force = false, saveToStore = true, loadEvents = true} = {}) => (
    (dispatch, getState, {api}) => {
        // Test if the Planning item is already loaded into the store
        // If so, return that instance instead
        const storedPlannings = selectors.planning.storedPlannings(getState());
        let promise;

        if (isPublishedItemId(pid)) {
            return Promise.resolve({});
        }

        if (has(storedPlannings, pid) && !force) {
            promise = Promise.resolve(storedPlannings[pid]);
        } else {
            promise = api('planning').getById(pid)
                .then((item) => {
                    planningUtils.modifyForClient(item);

                    if (saveToStore) {
                        dispatch(self.receivePlannings([item]));
                    }

                    return Promise.resolve(item);
                }, (error) => Promise.reject(error));
        }

        return promise.then((item) => {
            if (loadEvents) {
                return dispatch(self.fetchPlanningsEvents([item]))
                    .then(
                        () => Promise.resolve(item),
                        (error) => Promise.reject(error)
                    );
            }

            return Promise.resolve(item);
        }, (error) => Promise.reject(error));
    }
);

/**
 * Action Dispatcher to fetch planning history from the server
 * This will add the history of action on that planning item in planning history list
 * @param {object} currentPlanningId - Query parameters to send to the server
 * @return arrow function
 */
const fetchPlanningHistory = (currentPlanningId) => (
    (dispatch, getState, {api}) => (
        // Query the API and sort by created
        api('planning_history').query({
            where: {planning_id: currentPlanningId},
            max_results: 200,
            sort: '[(\'_created\', 1)]',
        })
            .then((data) => (Promise.resolve(data._items)), (error) => (Promise.reject(error)))
    )
);

/**
 * Action to receive the history of actions on planning item
 * @param {array} planningHistoryItems - An array of planning history items
 * @return object
 */
const receivePlanningHistory = (planningHistoryItems) => ({
    type: PLANNING.ACTIONS.RECEIVE_PLANNING_HISTORY,
    payload: planningHistoryItems,
});

/**
 * Action dispatcher to load Planning items by ID from the API, and place them
 * in the local store. This does not update the list of visible Planning items
 * @param {string} id - a single Planning ID to fetch
 * @param {string} spikeState - Planning item's spiked state (SPIKED, NOT_SPIKED or BOTH)
 * @param {boolean} saveToStore - If true, save the Planning item in the Redux store
 * @return Promise
 */
const loadPlanningById = (id, spikeState = SPIKED_STATE.BOTH, saveToStore = true) => (
    (dispatch, getState, {api}) => api('planning').getById(id)
        .then((item) => {
            planningUtils.modifyForClient(item);
            if (saveToStore) {
                dispatch(self.receivePlannings([item]));
            }

            return Promise.resolve([item]);
        }, (error) => (Promise.reject(error)))
);

const loadPlanningByIds = (ids, saveToStore = true) => (
    (dispatch, getState, {api}) => (
        api('planning').query({
            source: JSON.stringify({
                query: elastic.terms('_id', ids),
            }),
        })
            .then((data) => {
                let items = get(data, '_items', []);

                items.forEach((item) => {
                    planningUtils.modifyForClient((item));
                });

                if (saveToStore) {
                    dispatch(self.receivePlannings(items));
                }

                return Promise.resolve(items);
            }, (error) => Promise.reject(error))
    )
);

/**
 * Action dispatcher to load Planning items by Event ID from the API, and place them
 * in the local store. This does not update the list of visible Planning items
 * @param {Array, string} eventIds - The Event ID used to query the API
 * @param {boolean} loadToStore - If true, save the Planning Items to the Redux Store
 * @return Promise
 */
const loadPlanningByEventId = (eventIds, loadToStore = true) => (
    (dispatch, getState, {api}) => (
        api('planning').query({
            source: JSON.stringify({
                query: Array.isArray(eventIds) ?
                    elastic.terms('event_item', eventIds) :
                    elastic.term('event_item', eventIds),
            }),
        })
            .then((data) => {
                data._items.forEach((item) => {
                    planningUtils.modifyForClient(item);
                });

                if (loadToStore) {
                    dispatch(self.receivePlannings(data._items));
                }

                return Promise.resolve(data._items);
            }, (error) => Promise.reject(error))
    )
);

const loadPlanningByRecurrenceId = (recurrenceId, loadToStore = true) => (
    (dispatch, getState, {api}) => (
        api('planning').query({
            source: JSON.stringify({
                query: elastic.term('recurrence_id', recurrenceId),
            }),
        })
            .then((data) => {
                data._items.forEach((item) => {
                    planningUtils.modifyForClient(item);
                });

                if (loadToStore) {
                    dispatch(self.receivePlannings(data._items));
                }

                return Promise.resolve(data._items);
            }, (error) => Promise.reject(error))
    )
);

/**
 * Action dispatcher to query the API for all Planning items
 * that are currently locked
 * @return Array of locked Planning items
 */
const queryLockedPlanning = (params = {featureLock: false}) => (
    (dispatch, getState, {api}) => (
        api(params.featureLock ? 'planning_featured_lock' : 'planning').query({
            source: JSON.stringify({
                query: elastic.fieldExists('lock_session'),
            }),
        })
            .then(
                (data) => Promise.resolve(data._items),
                (error) => Promise.reject(error)
            )
    )
);

/**
 * Action Dispatcher to get a single Planning item
 * If the Planning item is already stored in the Redux store, then return that
 * Otherwise fetch the Planning item from the server and optionally
 * save the Planning item in the Redux store
 * @param {string} planId - The ID of the Planning item to retrieve
 * @param {boolean} saveToStore - If true, save the Planning item in the Redux store
 */
const getPlanning = (planId, saveToStore = true) => (
    (dispatch, getState) => {
        const plannings = selectors.planning.storedPlannings(getState());

        if (planId in plannings) {
            return Promise.resolve(plannings[planId]);
        }

        return dispatch(self.loadPlanningById(planId, SPIKED_STATE.BOTH, saveToStore))
            .then(
                (items) => Promise.resolve(items[0]),
                (error) => Promise.reject(error)
            );
    }
);

/**
 * Saves a Planning Item
 * If the item does not contain an _id, then it creates a new planning item instead
 * @param {object} original - If supplied, will use this as the original Planning item
 * @param {object} planUpdates - The Planning item to save
 * @return Promise
 */
const save = (original, planUpdates) => (
    (dispatch, getState, {api}) => {
        let promise;

        if (original) {
            promise = Promise.resolve(original);
        } else if (isExistingItem(planUpdates)) {
            promise = dispatch(self.fetchById(planUpdates._id));
        } else {
            promise = Promise.resolve({});
        }

        return promise.then((originalPlan) => {
            // Clone the original because `save` will modify it
            const originalItem = cloneDeep(originalPlan);

            // remove all properties starting with _ or lock_,
            let updates = pickBy(
                cloneDeep(planUpdates),
                (v, k) => ((k === TO_BE_CONFIRMED_FIELD || !k.startsWith('_')) && !k.startsWith('lock_'))
            );

            // remove nested original creator
            delete updates.original_creator;

            // remove revert_state
            delete updates.revert_state;

            if (updates.agendas) {
                updates.agendas = updates.agendas.map((agenda) => agenda._id || agenda);
            }

            planningUtils.modifyForServer(updates);

            if (isExistingItem(originalPlan) || get(updates, 'coverages.length', 0) < 1) {
                return api('planning').save(originalItem, updates);
            }

            // If the new Planning item has coverages then we need to create
            // the planning first before saving the coverages
            // As assignments are created and require a Planning ID
            let modifiedUpdates = cloneDeep(updates);

            if (updates.pubstatus === POST_STATE.USABLE) {
                // We are create&posting from add-to-planning
                delete modifiedUpdates.pubstatus;
                delete modifiedUpdates.state;
            }

            const addToPlanning = {
                add_to_planning: selectors.general.currentWorkspace(getState()) === WORKSPACE.AUTHORING,
            };

            return api('planning').save(
                {},
                {
                    ...modifiedUpdates,
                    coverages: [],
                }, addToPlanning

            )
                .then(
                    (originalItem) => api('planning').save(originalItem, updates, addToPlanning),
                    (error) => Promise.reject(error)
                );
        });
    }
);

const duplicate = (plan) => (
    (dispatch, getState, {api}) => (
        api('planning_duplicate', plan).save({})
            .then((newPlan) => {
                newPlan.type = 'planning';
                return Promise.resolve(newPlan);
            }, (error) => (
                Promise.reject(error)
            ))
    )
);

/**
 * Set a Planning item as Posted
 * @param {Object} original - Planning item
 * @param {Object} updates - Planning item
 */
const post = (original, updates) => (
    (dispatch, getState, {api}) => (
        api.save('planning_post', {
            planning: original._id,
            etag: original._etag,
            pubstatus: get(updates, 'pubstatus', POST_STATE.USABLE),
        }).then(
            () => dispatch(self.fetchById(original._id, {force: true})),
            (error) => Promise.reject(error)
        )
    )
);

/**
 * Set a Planning item as not Posted
 * @param {Object} original - Planning item ID
 * @param {Object} updates - Planning item ID
 */
const unpost = (original, updates) => (
    (dispatch, getState, {api}) => (
        api.save('planning_post', {
            planning: original._id,
            etag: original._etag,
            pubstatus: get(updates, 'pubstatus', POST_STATE.CANCELLED),
        }).then(
            () => dispatch(self.fetchById(original._id, {force: true})),
            (error) => Promise.reject(error)
        )
    )
);

/**
 * Action for updating the list of planning items in the redux store
 * Also loads all the associated contacts (if any)
 * @param  {array, object} plannings - An array of planning item objects
 */
const receivePlannings = (plannings) => (
    (dispatch) => {
        dispatch(actions.contacts.fetchContactsFromPlanning(plannings));
        dispatch({
            type: PLANNING.ACTIONS.RECEIVE_PLANNINGS,
            payload: plannings,
        });
    }
);

/**
 * Action dispatcher that attempts to unlock a Planning item through the API
 * @param {object} item - The Planning item to unlock
 * @return Promise
 */
const unlock = (item) => (
    (dispatch, getState, {api}) => (
        api('planning_unlock', item).save({})
    )
        .then((item) => {
            planningUtils.modifyForClient(item);

            dispatch({
                type: PLANNING.ACTIONS.UNLOCK_PLANNING,
                payload: {plan: item},
            });

            return Promise.resolve(item);
        }, (error) => Promise.reject(error))
);

/**
 * Action dispatcher that attempts to lock a Planning item through the API
 * @param {object} planning - The Planning item to lock
 * @param {String} lockAction - The lock action
 * @return Promise
 */
const lock = (planning, lockAction = 'edit') => (
    (dispatch, getState, {api}) => {
        if (lockAction === null ||
            lockUtils.isItemLockedInThisSession(
                planning,
                selectors.general.session(getState()),
                selectors.locks.getLockedItems(getState())
            )
        ) {
            return Promise.resolve(planning);
        }

        return api('planning_lock', planning).save({}, {lock_action: lockAction})
            .then((item) => {
                planningUtils.modifyForClient(item);

                dispatch({
                    type: PLANNING.ACTIONS.LOCK_PLANNING,
                    payload: {plan: item},
                });

                return Promise.resolve(item);
            }, (error) => Promise.reject(error));
    }
);

/**
 * Locks featured stories action
 * @return Promise
 */
const lockFeaturedPlanning = () => (
    (dispatch, getState, {api}) => (
        api('planning_featured_lock').save({}, {})
            .then((lockedItem) => lockedItem)
    )
);


/**
 * Fetches featured stories record
 * @param {string} id - id of the record
 * @return Promise
 */
const fetchFeaturedPlanningItemById = (id) => (
    (dispatch, getState, {api}) => api.find('planning_featured', id).then((item) => item)
);

const fetchPlanningFiles = (planning) => (
    (dispatch, getState) => {
        if (!planningUtils.shouldFetchFilesForPlanning(planning)) {
            return Promise.resolve();
        }

        const filesToFetch = planningUtils.getPlanningFiles(planning);
        const filesInStore = selectors.general.files(getState());

        if (every(filesToFetch, (f) => f in filesInStore)) {
            return Promise.resolve();
        }

        return dispatch(getFiles(filesToFetch));
    }
);

const getFiles = (files) => (
    (dispatch, getState, {api}) => (
        api('planning_files').query(
            {
                where: {$and: [{_id: {$in: files}}]},
            }
        )
            .then((data) => {
                if (get(data, '_items.length')) {
                    dispatch({
                        type: 'RECEIVE_FILES',
                        payload: get(data, '_items'),
                    });
                }
                return Promise.resolve();
            })
    )
);


/**
 * Action dispatcher to save the featured planning record through the API
 * @param {object} updates - updates to save
 * @return Promise
 */
const saveFeaturedPlanning = (updates) => (
    (dispatch, getState, {api}) => {
        const item = selectors.featuredPlanning.featuredPlanningItem(getState()) || {};

        return api('planning_featured').save(cloneDeep(item), {...updates})
            .then((savedItem) => savedItem);
    }
);


/**
 * Unlocks featured planning action
 * @return Promise
 */
const unlockFeaturedPlanning = () => (
    (dispatch, getState, {api, notify}) => (
        api('planning_featured_unlock').save({}, {})
            .catch((error) => {
                notify.error(
                    getErrorMessage(error, gettext('Failed to unlock featured story action!')));
            })
    )
);

const markPlanningCancelled = (plan, reason, coverageState, eventCancellation) => ({
    type: PLANNING.ACTIONS.MARK_PLANNING_CANCELLED,
    payload: {
        planning_item: plan,
        reason: reason,
        coverage_state: coverageState,
        event_cancellation: eventCancellation,
    },
});

const markCoverageCancelled = (plan, reason, coverageState, ids, etag) => ({
    type: PLANNING.ACTIONS.MARK_COVERAGE_CANCELLED,
    payload: {
        planning_item: plan,
        reason: reason,
        coverage_state: coverageState,
        ids: ids,
        etag: etag,
    },
});

const markPlanningPostponed = (plan, reason) => ({
    type: PLANNING.ACTIONS.MARK_PLANNING_POSTPONED,
    payload: {
        planning_item: plan,
        reason: reason,
    },
});

const uploadFiles = (planning) => (
    (dispatch, getState, {upload}) => {
        const clonedPlanning = cloneDeep(planning);

        // If no files, do nothing
        if (get(clonedPlanning, 'files.length', 0) === 0) {
            return Promise.resolve([]);
        }

        // Calculate the files to upload
        const filesToUpload = clonedPlanning.files.filter(
            (f) => isValidFileInput(f)
        );

        if (filesToUpload.length < 1) {
            return Promise.resolve([]);
        }

        return Promise.all(filesToUpload.map((file) => (
            upload.start({
                method: 'POST',
                url: appConfig.server.url + '/planning_files/',
                headers: {'Content-Type': 'multipart/form-data'},
                data: {media: [file]},
                arrayKey: '',
            })
        )))
            .then((results) => {
                const files = results.map((res) => res.data);

                if (get(files, 'length', 0) > 0) {
                    dispatch({
                        type: 'RECEIVE_FILES',
                        payload: files,
                    });
                }
                return Promise.resolve(files);
            }, (error) => Promise.reject(error));
    }
);

const removeFile = (file) => (
    (dispatch, getState, {api, notify}) => (
        api('planning_files').remove(file)
            .then(() => {
                dispatch({
                    type: 'REMOVE_FILE',
                    payload: file._id,
                });
            }, (err) => {
                notify.error(
                    getErrorMessage(err, gettext('Failed to remove the file from planning.'))
                );
                return Promise.reject(err);
            })
    )
);

// eslint-disable-next-line consistent-this
const self = {
    spike,
    unspike,
    query,
    fetch,
    receivePlannings,
    save,
    fetchById,
    fetchPlanningsEvents,
    unlock,
    lock,
    loadPlanningById,
    loadPlanningByIds,
    fetchPlanningHistory,
    receivePlanningHistory,
    loadPlanningByEventId,
    post,
    unpost,
    refetch,
    duplicate,
    markPlanningCancelled,
    markCoverageCancelled,
    markPlanningPostponed,
    queryLockedPlanning,
    getPlanning,
    loadPlanningByRecurrenceId,
    cancel,
    cancelAllCoverage,
    lockFeaturedPlanning,
    unlockFeaturedPlanning,
    saveFeaturedPlanning,
    fetchFeaturedPlanningItemById,
    fetchPlanningFiles,
    uploadFiles,
    removeFile,
    getFiles,
};

export default self;
