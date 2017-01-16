# -*- coding: utf-8; -*-
#
# This file is part of Superdesk.
#
# Copyright 2013, 2014 Sourcefabric z.u. and contributors.
#
# For the full copyright and license information, please see the
# AUTHORS and LICENSE files distributed with this source code, or
# at https://www.sourcefabric.org/superdesk/license

"""Superdesk Events"""

import superdesk
import logging
from superdesk import get_resource_service
from superdesk.metadata.utils import generate_guid
from superdesk.metadata.item import GUID_NEWSML
from apps.archive.common import set_original_creator
from dateutil.rrule import rrule, YEARLY, MONTHLY, WEEKLY, DAILY, MO, TU, WE, TH, FR, SA, SU
from eve.defaults import resolve_default_values
from eve.methods.common import resolve_document_etag
from eve.utils import config
from flask import current_app as app
import itertools
import copy
import pytz
import re

logger = logging.getLogger(__name__)

not_analyzed = {'type': 'string', 'index': 'not_analyzed'}
not_indexed = {'type': 'string', 'index': 'no'}

FREQUENCIES = {'DAILY': DAILY, 'WEEKLY': WEEKLY, 'MONTHLY': MONTHLY, 'YEARLY': YEARLY}
DAYS = {'MO': MO, 'TU': TU, 'WE': WE, 'TH': TH, 'FR': FR, 'SA': SA, 'SU': SU}

organizer_roles = {
    'eorol:artAgent': 'Artistic agent',
    'eorol:general': 'General organiser',
    'eorol:tech': 'Technical organiser',
    'eorol:travAgent': 'Travel agent',
    'eorol:venue': 'Venue organiser'
}

occurrence_statuses = {
    'eocstat:eos0': 'Unplanned event',
    'eocstat:eos1': 'Planned, occurence planned only',
    'eocstat:eos2': 'Planned, occurence highly uncertain',
    'eocstat:eos3': 'Planned, May occur',
    'eocstat:eos4': 'Planned, occurence highly likely',
    'eocstat:eos5': 'Planned, occurs certainly'
}


class EventsService(superdesk.Service):
    """Service class for the events model."""

    def post_in_mongo(self, docs, **kwargs):
        for doc in docs:
            resolve_default_values(doc, app.config['DOMAIN'][self.datasource]['defaults'])
        self.on_create(docs)
        resolve_document_etag(docs, self.datasource)
        ids = self.backend.create_in_mongo(self.datasource, docs, **kwargs)
        self.on_created(docs)
        return ids

    def patch_in_mongo(self, id, document, original):
        res = self.backend.update_in_mongo(self.datasource, id, document, original)
        return res

    def set_ingest_provider_sequence(self, item, provider):
        """Sets the value of ingest_provider_sequence in item.

        :param item: object to which ingest_provider_sequence to be set
        :param provider: ingest_provider object, used to build the key name of sequence
        """
        sequence_number = get_resource_service('sequences').get_next_sequence_number(
            key_name='ingest_providers_{_id}'.format(_id=provider[config.ID_FIELD]),
            max_seq_number=app.config['MAX_VALUE_OF_INGEST_SEQUENCE']
        )
        item['ingest_provider_sequence'] = str(sequence_number)

    def on_create(self, docs):
        # events generated by recurring rules
        generatedEvents = []
        for event in docs:
            # generates an unique id
            event['guid'] = generate_guid(type=GUID_NEWSML)
            # set the author
            set_original_creator(event)
            # generates events based on recurring rules
            if event['dates'].get('recurring_rule', {}).get('frequency'):
                # generate a common id for all the events we will generate
                recurrence_id = generate_guid(type=GUID_NEWSML)
                # compute the difference between start and end in the original event
                time_delta = event['dates']['end'] - event['dates']['start']
                # for all the dates based on the recurring rules:
                for date in itertools.islice(generate_recurring_dates(
                    start=event['dates']['start'],
                    tz=event['dates'].get('tz') and pytz.timezone(event['dates']['tz'] or None),
                    **event['dates']['recurring_rule']
                ), 0, 1000):  # set a limit to prevent too many events to be created
                    # create event with the new dates
                    new_event = copy.deepcopy(event)
                    new_event['dates']['start'] = date
                    new_event['dates']['end'] = date + time_delta
                    # set the recurrence id
                    new_event['recurrence_id'] = recurrence_id
                    generatedEvents.append(new_event)
                # remove the event that contains the recurring rule. We don't need it anymore
                docs.remove(event)
        if generatedEvents:
            docs.extend(generatedEvents)


events_schema = {
    # Identifiers
    'guid': {
        'type': 'string',
        'unique': True,
        'mapping': not_analyzed
    },
    'unique_id': {
        'type': 'integer',
        'unique': True,
    },
    'unique_name': {
        'type': 'string',
        'unique': True,
        'mapping': not_analyzed
    },
    'version': {
        'type': 'integer'
    },
    'ingest_id': {
        'type': 'string',
        'mapping': not_analyzed
    },
    'recurrence_id': {
        'type': 'string',
        'unique': True,
        'mapping': not_analyzed
    },

    # Audit Information
    'original_creator': superdesk.Resource.rel('users'),
    'version_creator': superdesk.Resource.rel('users'),
    'firstcreated': {
        'type': 'datetime'
    },
    'versioncreated': {
        'type': 'datetime'
    },

    # Ingest Details
    'ingest_provider': superdesk.Resource.rel('ingest_providers'),
    'source': {     # The value is copied from the ingest_providers vocabulary
        'type': 'string',
        'mapping': not_analyzed
    },
    'original_source': {    # This value is extracted from the ingest
        'type': 'string',
        'mapping': not_analyzed
    },
    'ingest_provider_sequence': {
        'type': 'string',
        'mapping': not_analyzed
    },

    # Event Details
    # NewsML-G2 Event properties See IPTC-G2-Implementation_Guide 15.2
    'name': {
        'type': 'string',
        'required': True,
    },
    'definition_short': {'type': 'string'},
    'definition_long': {'type': 'string'},
    'anpa_category': {
        'type': 'list',
        'nullable': True,
        'mapping': {
            'type': 'object',
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed,
            }
        }
    },
    'relationships': {
        'type': 'dict',
        'schema': {
            'broader': {'type': 'string'},
            'narrower': {'type': 'string'},
            'related': {'type': 'string'}
        },
    },

    # NewsML-G2 Event properties See IPTC-G2-Implementation_Guide 15.4.3
    'dates': {
        'type': 'dict',
        'schema': {
            'start': {'type': 'datetime'},
            'end': {'type': 'datetime'},
            'tz': {'type': 'string'},
            'duration': {'type': 'string'},
            'confirmation': {'type': 'string'},
            'recurring_date': {
                'type': 'list',
                'nullable': True,
                'mapping': {
                    'type': 'date'
                }
            },
            'recurring_rule': {
                'type': 'dict',
                'schema': {
                    'frequency': {'type': 'string'},
                    'interval': {'type': 'integer'},
                    'until': {'type': 'datetime'},
                    'count': {'type': 'integer'},
                    'bymonth': {'type': 'string'},
                    'byday': {'type': 'string'},
                    'byhour': {'type': 'string'},
                    'byminute': {'type': 'string'}
                }
            },
            'ex_date': {
                'type': 'list',
                'mapping': {
                    'type': 'date'
                }
            },
            'ex_rule': {
                'type': 'dict',
                'schema': {
                    'frequency': {'type': 'string'},
                    'interval': {'type': 'string'},
                    'until': {'type': 'datetime'},
                    'count': {'type': 'integer'},
                    'bymonth': {'type': 'string'},
                    'byday': {'type': 'string'},
                    'byhour': {'type': 'string'},
                    'byminute': {'type': 'string'}
                }
            }
        }
    },  # end dates
    'occur_status': {
        'type': 'dict',
        'schema': {
            'qcode': {'type': 'string'},
            'name': {'type': 'string'}
        }
    },
    'news_coverage_status': {
        'type': 'dict',
        'schema': {
            'qcode': {'type': 'string'},
            'name': {'type': 'string'}
        }
    },
    'registration': {
        'type': 'string'
    },
    'access_status': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    },
    'subject': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    },
    'location': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed,
                'geo': not_analyzed
            }
        }
    },
    'participant': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    },
    'participant_requirement': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    },
    'organizer': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    },
    'contact_info': {
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    },
    'language': {  # TODO: this is only placeholder schema
        'type': 'list',
        'mapping': {
            'properties': {
                'qcode': not_analyzed,
                'name': not_analyzed
            }
        }
    }
}  # end events_schema


class EventsResource(superdesk.Resource):
    """Resource for events data model

    See IPTC-G2-Implementation_Guide (version 2.21) Section 15.4 for schema details
    """

    url = 'events'
    schema = events_schema
    resource_methods = ['GET', 'POST']
    datasource = {
        'source': 'events',
        'search_backend': 'elastic',
    }
    item_methods = ['GET', 'PATCH', 'PUT', 'DELETE']
    public_methods = ['GET']
    privileges = {'POST': 'planning',
                  'PATCH': 'planning',
                  'DELETE': 'planning'}


def generate_recurring_dates(start, frequency, interval=1, until=None, byday=None, count=None, tz=None):
    """

    Returns list of dates related to recurring rules

    :param start datetime: date when to start
    :param frequency str: DAILY, WEEKLY, MONTHLY, YEARLY
    :param interval int: indicates how often the rule repeats as a positive integer
    :param until datetime: date after which the recurrence rule expires
    :param byday str or list: "MO TU"
    :param count int: number of occurrences of the rule
    :return list: list of datetime

    """
    # if tz is given, respect the timzone by starting from the local time
    # NOTE: rrule uses only naive datetime
    if tz:
        try:
            # start can already be localized
            start = pytz.UTC.localize(start)
        except ValueError:
            pass
        start = start.astimezone(tz).replace(tzinfo=None)
        if until:
            until = until.astimezone(tz).replace(tzinfo=None)

    # check format of the recurring_rule byday value
    if byday and re.match(r'^-?[1-5]+.*', byday):
        # byday uses monthly or yearly frequency rule with day of week and
        # preceeding day of month intenger byday value
        # examples:
        # 1FR - first friday of the month
        # -2MON - second to last monday of the month
        if byday[:1] == '-':
            day_of_month = int(byday[:2])
            day_of_week = byday[2:]
        else:
            day_of_month = int(byday[:1])
            day_of_week = byday[1:]

        byweekday = DAYS.get(day_of_week)(day_of_month)
    else:
        # byday uses DAYS constants
        byweekday = byday and [DAYS.get(d) for d in byday.split()] or None
    # TODO: use dateutil.rrule.rruleset to incude ex_date and ex_rule
    dates = rrule(
        FREQUENCIES.get(frequency),
        dtstart=start,
        until=until,
        byweekday=byweekday,
        count=count,
        interval=interval,
    )
    # if a timezone has been applied, returns UTC
    if tz:
        return (tz.localize(dt).astimezone(pytz.UTC).replace(tzinfo=None) for dt in dates)
    else:
        return (date for date in dates)
