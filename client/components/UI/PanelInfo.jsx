import React from 'react';
import PropTypes from 'prop-types';

/**
 * @ngdoc react
 * @name PanelInfo
 * @description Information displayed in the middle of a panel
 */
const PanelInfo = ({heading, description, showIcon}) => (
    <div className="panel-info">
        {showIcon && (
            <div className="panel-info__icon">
                <i className="big-icon--comments" />
            </div>
        )}
        {heading &&
            <h3 className="panel-info__heading">{heading}</h3>
        }
        {description &&
            <p className="panel-info__description">{description}</p>
        }
    </div>
);

PanelInfo.propTypes = {
    heading: PropTypes.string,
    description: PropTypes.string,
    showIcon: PropTypes.bool,
};

PanelInfo.defaultProps = {
    showIcon: true,
};

export default PanelInfo;
