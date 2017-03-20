import React, { PropTypes } from 'react'
import DatePicker from 'react-datepicker'
import { touch } from 'redux-form'
import TimePicker from 'rc-time-picker'
import moment from 'moment'
import 'react-datepicker/dist/react-datepicker.css'
import 'rc-time-picker/assets/index.css'
import './style.scss'

export class DayPickerInput extends React.Component {

    constructor(props) {
        super(props)
        const selectedDate = this.props.input.value ?
            moment(this.props.input.value) : this.props.defaultDate ?
            moment(this.props.defaultDate) : undefined
        // get the time in a different variable (different field)
        const selectedTime = selectedDate ? moment(selectedDate) : undefined
        // remove the time from the date
        if (selectedDate) selectedDate.startOf('day')
        this.state = {
            selectedTime,
            selectedDate,
        }
    }

    componentWillMount() {
        // set as touched if there is an initial value. This prevent the default value
        // to take over in componentWillReceiveProps
        if (this.props.input.value) this.touch()
    }

    /** open the date picker */
    focus() {
        this.refs.datePicker.handleFocus()
    }

    touch() {
        return this.props.meta.dispatch(touch(this.props.meta.form, this.props.input.name))
    }

    setStateFromDate(_date) {
        return new Promise((resolve) => {
            // if there is no date, reset the state
            if (!_date) {
                return this.setState({ selectedTime: undefined, selectedDate: undefined }, resolve())
            }
            // otherwise compute the value of date and time fields
            let date = moment(_date)
            // get the time in a different variable (different field)
            const selectedTime = date ? moment(date) : undefined
            // remove the time from the date
            if (date) date.startOf('day')
            this.setState({
                selectedTime,
                selectedDate: date,
            }, resolve())
        })
    }

    /** Update the state when the props change */
    componentWillReceiveProps(nextProps) {
        // use default date only when untouched
        if (!nextProps.meta.touched && nextProps.defaultDate !== this.props.defaultDate) {
            this.setStateFromDate(nextProps.defaultDate)
            .then(() => this.updateValueFromState())
        } else {
            if (nextProps.input.value !== this.props.input.value) {
                this.setStateFromDate(nextProps.input.value)
                .then(() => this.updateValueFromState())
            }
        }
    }

    onDayChange(selectedDate) {
        this.setState(
            // given date is utc, we convert to local
            { selectedDate: moment(selectedDate.format('YYYY-MM-DDTHH:mm:ss')) },
            () => {
                this.touch()
                this.updateValueFromState()
            }
        )
    }

    onTimeChange(selectedTime) {
        this.setState({ selectedTime },
            () => {
                this.touch()
                this.updateValueFromState()
            }
        )
    }

    updateValueFromState() {
        if (this.state.selectedDate) {
            let datetime = this.state.selectedDate.clone()
            // set the time if required
            if (this.props.withTime && this.state.selectedTime) {
                datetime
                .hour(this.state.selectedTime.hours())
                .minute(this.state.selectedTime.minutes())
            }
            // updates the field value
            this.props.input.onChange(datetime ? datetime : undefined)
        }
    }

    componentDidMount() {
        // after first render, set value of the form input
        this.updateValueFromState()
    }

    render() {
        const { disabled, withTime, selectsEnd, selectsStart, startDate, endDate } = this.props
        const { touched, error, warning } = this.props.meta
        const { selectedDate, selectedTime } = this.state
        return (
            <span className="day-picker-input">
                {
                    touched && ((error && <div className="day-picker-input__error">{error}</div>) ||
                    (warning && <div className="day-picker-input__error">{warning}</div>))
                }
                <DatePicker
                    ref="datePicker"
                    disabled={disabled}
                    className="line-input"
                    selectsEnd={selectsEnd}
                    selectsStart={selectsStart}
                    startDate={startDate}
                    endDate={endDate}
                    selected={selectedDate}
                    onChange={this.onDayChange.bind(this)}
                    fixedHeight />
                {(withTime === true) && (
                    <TimePicker
                        disabled={disabled}
                        placeholder="Time"
                        value={selectedTime}
                        showSecond={false}
                        hideDisabledOptions={true}
                        onChange={this.onTimeChange.bind(this)} />
                )}
            </span>
        )
    }
}
DayPickerInput.propTypes = {
    withTime: PropTypes.bool,
    defaultDate: PropTypes.object,
    input: PropTypes.object,
    meta: PropTypes.object,
    disabled: PropTypes.bool,
    selectsEnd: PropTypes.bool,
    selectsStart: PropTypes.bool,
    startDate: PropTypes.object,
    endDate: PropTypes.object,
}
DayPickerInput.defaultProps = { withTime: false, meta: {} }