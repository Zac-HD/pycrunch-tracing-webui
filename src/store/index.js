// @flow
import Vue from 'vue'
import Vuex, {ActionContext} from 'vuex'
import io from 'socket.io-client'
import {parents, short} from '../views/code/short-filename'
import { FileWithId, parse_files_with_contents, parse_protobuf_datastream } from './protobuf_message_parsing'
import {CodeEvent, CodeFile, LiveTracker, ProfileDetails, TracingSession, UiState} from './models'
import global_state from './global_state'
import {seek_back_in_current_method, seek_step_out_backwards,
  seek_step_out_forward, step_over_from_current_event} from './debugging-steper'

import {EventBus} from '../shared/event-bus'
import { FileHeader, FileSection } from './tracer-binary.file'

Vue.use(Vuex)

class MyState {
  is_connected: boolean = false
  current_session: TracingSession = null
  selected_file: CodeFile
  file_refs: Array<FileWithId> = []
  files: Array<CodeFile> = []
  active_trackers: Array<LiveTracker> = []
  selected_index: number = 0
  selected_event: CodeEvent = null
  ui: UiState = new UiState()
  tracing_sessions: Array<TracingSession> = []
  total_events: number = 0
  profiles: Array<string> = []
  profile_details: ProfileDetails = null
}

function getState (): MyState {
  return new MyState()
}

let url = 'http://192.168.1.174:8080'
url = 'http://127.0.0.1:8080'
let socket = io(url)
export default new Vuex.Store({
  state: getState(),
  mutations: {
    profile_details_did_load (state: MyState, payload: any) {
      state.profile_details = payload
    },
    profiles_did_load (state: MyState, payload: any) {
      state.profiles.length = 0
      payload.profiles.forEach((_: string) => {
        state.profiles.push(_)
      })
    },
    session_will_load (state: MyState, session_name: string) {
      let currentSession = state.tracing_sessions.find((_: TracingSession) => _.short_name === session_name)
      if (currentSession) {
        state.current_session = currentSession
      }
    },
    did_unignore_file (state: MyState, filename: string) {
      state.ui.unignore_file(filename)
    },
    did_unignore_folder (state: MyState, folder: string) {
      state.ui.unignore_folder(folder)
    },
    did_ignore_file (state: MyState, filename: string) {
      state.ui.ignore_file(filename)
    },
    did_ignore_folder (state: MyState, folder: string) {
      state.ui.ignore_folder(folder)
    },

    did_connect (state: MyState) {
      state.is_connected = true
    },
    did_disconnect (state: MyState) {
      state.is_connected = false
    },
    new_tracker_did_connect (state: MyState, data) {
      state.active_trackers.push(new LiveTracker(data.sid, data.version))
    },
    tracker_did_disconnect (state: MyState, sid) {
      console.log('tracker_did_disconnect')
      let possibleSession = state.active_trackers.find((_: LiveTracker) => _.sid === sid)

      if (possibleSession) {
        state.active_trackers.splice(state.active_trackers.indexOf(possibleSession), 1)
      }
    },

    update_filtered_events (state: MyState, payload) {
      global_state.command_buffer.length = 0
      let back_buffer = []
      global_state.entire_command_buffer.forEach(_ => {
        if (!state.ui.is_filtered(_)) {
          back_buffer.push(_)
        }
      })
      global_state.command_buffer = back_buffer
      state.total_events = global_state.command_buffer.length
      EventBus.$emit('display_events_did_update', state.total_events)

    },
    did_receive_buffer (state: MyState, payload) {
      let msg = parse_protobuf_datastream(payload)
      global_state.entire_command_buffer.length = 0
      global_state.all_stacks.length = 0

      global_state.entire_command_buffer = msg.command_buffer
      global_state.all_stacks = msg.stacks

      msg.files.forEach((_: FileWithId) =>  {
        global_state.files[_.id] = _.file
      })
      // todo do i need it?
      state.file_refs.length = 0
      state.file_refs = [...msg.files]
      // let x = goog.require('proto.TraceSession');
      // debugger
    },
    file_did_load (state: MyState, payload) {
      let x = new CodeFile()
      x.filename = payload.filename
      x.contents = payload.contents
      state.files.filterInPlace(function (_: CodeFile) {
        return _.filename !== x.filename
      })

      state.files.push(x)
    },
    selected_file_will_change (state: MyState, payload) {
      state.selected_file = state.files[0]
    },

    selected_index_will_change (state: MyState, payload) {
      function follow_cursor_if_enabled (state) {
        if (!state.ui.follow_cursor) {
          return
        }
        // console.group('scroll decision')
        let selectedEvent = state.selected_event
        if (!selectedEvent) {
          return
        }

        let selector = 'a[name=line' + selectedEvent.cursor.line +"]"
        let x = window.top.document.querySelectorAll(selector)
        if (x.length <= 0 ) {
        //  todo retry
        //  no such element
          return
        }

        let line_element = x[0]
        let newTop = line_element.offsetTop - 100
        // console.log(x)


        let scrollTop = window.scrollY
        let up_treshold = scrollTop - 100
        if (up_treshold < 0) {
          up_treshold = 0
        }

        let down_treshold = scrollTop + 200
        let needScroll = false
        let newTopLessTres = newTop < up_treshold
        let newTopGreaterDown = newTop > down_treshold
        if (newTopLessTres || newTopGreaterDown) {
          needScroll = true
        }
        // console.table({needScroll,newTop, scrollTop,
        // up_treshold, down_treshold,
        // needScroll, newTopLessTres, newTopGreaterDown} )

        if (needScroll) {
          // console.log('scrolling to ', newTop)
          setTimeout(() => {
            window.scrollTo({
              top: newTop,
              // behavior: 'smooth'
            })
          }, 100)
        }

        // console.groupEnd()
      }

      let old_index = state.selected_index
      let new_index = payload

      state.selected_index = new_index
      state.selected_event = global_state.command_buffer[new_index]

      follow_cursor_if_enabled(state)
    },
    will_toggle_ui_panel (state: MyState, panel_name: string) {
      state.ui.toggle_panel(panel_name)
    },
    toggle_ui_follow_cursor (state: MyState, payload) {
      state.ui.follow_cursor = !state.ui.follow_cursor
    },
    session_list_did_load (state: MyState, payload: Array<any>) {
      state.tracing_sessions.length = 0
      payload.forEach(_ => state.tracing_sessions.push(_))
    },
    add_new_ignore_rule (state: MyState, payload: Array<any>) {
      state.profile_details.exclusions.push(payload)
    },
    remove_ignore_rule (state: MyState, payload: string) {
      let indexOf = state.profile_details.exclusions.indexOf(payload)
      if (indexOf >= 0) {
        state.profile_details.exclusions.splice(indexOf, 1)
      }
    },
  },
  actions: {
    will_open_local_trace(context: ActionContext, native_event: any) {

      const file = native_event.target.files[0];
      let name = file.name
      const reader = new FileReader();
      reader.onload = (e: any) => {
        function read_uint64 (from_data_view : DataView, at_offset: number) {
          // const bytes = new Uint8Array([ 0xff,0xff,0xff,0xff,   0xff,0xff,0xff,0xff ]);
          // split 64-bit number into two 32-bit numbers

          // combine the 2 32-bit numbers using max 32-bit val 0xffffffff
          let right = from_data_view.getUint32(at_offset)  // 4294967295
          let left = from_data_view.getUint32(at_offset + 4) // 4294967295
          return left + 2 ** 32 * right
        }
        global_state.entire_command_buffer.length = 0
        global_state.all_stacks.length = 0

        let buffer : ArrayBuffer = e.target.result
        let total_length = buffer.byteLength
        let z = new DataView(buffer)
        let header_size = 4
        let offset = 0
        // signature

        let h = new FileHeader()

        let signature = z.getInt32(offset)
        if (signature !== h.magic) {
          console.error('File signature is invalid')
          EventBus.$emit('trace_load_will_fail', name)
          return
        }
        offset += 4
        h.header_size = z.getInt32(offset)
        offset += 4

        const event_stream_end_offset = read_uint64(z, offset)
        offset += 8

        const files_byte_len = read_uint64(z, offset)
        h.files_section = new FileSection('files', event_stream_end_offset + 4, files_byte_len)

        offset += 8
        // 8 = 4 sig + 4 header len
        offset = h.header_size + 8
        signature = z.getInt32(offset)
        if (signature !== h.magic) {
          console.error('Trailing file signature is invalid')
          EventBus.$emit('trace_load_will_fail', name)
          return
        }
        offset += 4

        h.events_section = new FileSection('events', offset, event_stream_end_offset - offset)

        while (offset < h.events_section.offset + h.events_section.length) {

          // (get_payment_methods) should be: 115981
          let chunk_size = z.getInt32(offset)
          offset += header_size

          let slice = buffer.slice(offset , offset + chunk_size)

          let msg = parse_protobuf_datastream(slice)

          global_state.entire_command_buffer.push(...msg.command_buffer)
          global_state.all_stacks.push(...msg.stacks)

          msg.files.forEach((_: FileWithId) =>  {
            global_state.files[_.id] = _.file
          })

          offset += chunk_size

        }
        // files
        offset += header_size
        let slice = buffer.slice(h.files_section.offset, h.files_section.offset + h.files_section.length)
        let msg = parse_files_with_contents(slice)
        msg.files_contents.forEach(_ => {
          let enc = new TextDecoder();

          let contents = 'File cannot be loaded...'
          if (_.contents) {
            contents = enc.decode(_.contents)
          }
          let payload = {
            filename: global_state.file_at(_.id),
            contents: contents
          }
          context.commit('file_did_load', payload )

        })
        context.commit('update_filtered_events')
        context.commit('selected_index_will_change', 0)
        EventBus.$emit('new_file_did_load', {})
      };

      reader.readAsArrayBuffer(file);

    },
    load_profile_details (context: ActionContext, profile_name: string) {
      socket.emit('event', {
        action: 'load_profile_details',
        profile_name: profile_name,
      })
    },
    save_profile_details (context: ActionContext, dummy: any) {
      let state: MyState = context.state
      socket.emit('event', {
        action: 'save_profile_details',
        profile: state.profile_details,
      })
    },
    unignore_file (context: ActionContext, filename: string) {
      context.commit('did_unignore_file', filename)
      context.commit('update_filtered_events')
    },
    unignore_folder (context: ActionContext, folder: string) {
      context.commit('did_unignore_folder', folder)
      context.commit('update_filtered_events')
    },
    ignore_current_file (context: ActionContext) {
      let selected_event: CodeEvent = context.state.selected_event
      context.commit('did_ignore_file', selected_event.cursor.file)
      context.commit('update_filtered_events')
    },
    ignore_folder (context: ActionContext, payload: string) {
      let selected_event: CodeEvent = context.state.selected_event
      context.commit('did_ignore_folder', payload)
      context.commit('update_filtered_events')
    },
    load_file (context: ActionContext, payload) {
      socket.emit('event', {
        action: 'load_file',
        file_to_load: payload.file,
      })
    },
    load_session (context: ActionContext, payload) {
      context.commit('session_will_load', payload)

      socket.emit('event', {
        action: 'load_single_session',
        session_name: payload,
      })
    },
    async connect (context: ActionContext) {
      socket.on('connect', on_connect)

      async function on_connect () {
        context.commit('did_connect')
        console.log(socket.connected) // true
        context.dispatch('load_sessions')
        context.dispatch('load_profiles')
      }

      socket.on('disconnect', () => {
        context.commit('did_disconnect')
      })
      socket.on('reply', (data) => {
        context.commit('did_receive_buffer', data)
        context.commit('update_filtered_events')
        context.commit('selected_index_will_change', 0)

        let files = new Set()
        //
        global_state.files.forEach((value: string) => {
          if (value) {
            files.add(value)
          }
        })

        files.forEach(_ => context.dispatch('load_file', {file: _}))

      })
      socket.on('file_did_load', (data) => {
        context.commit('file_did_load', data)
        context.commit('selected_file_will_change')
      })

      socket.on('session_list_loaded', (data) => {
        context.commit('session_list_did_load', data)
      })
      socket.on('profiles_loaded', (data) => {
        context.commit('profiles_did_load', data)
      })
      socket.on('profile_details_loaded', (data) => {
        context.commit('profile_details_did_load', data)
      })
      socket.on('front', (data) => {

        // console.group('front event')
        // console.table(data)
        // console.groupEnd()
        if (data.event_name) {
          let e = data.event_name
          if (e === 'new_tracker') {
            context.commit('new_tracker_did_connect', data)
          } else if (e === 'tracker_did_disconnect') {
            context.commit('tracker_did_disconnect', data.sid)
          }

        }
      })
    },
    load_sessions (context: ActionContext) {
      socket.emit('event', {
        action: 'load_sessions',
      })

    },
    load_profiles (context: ActionContext) {
      socket.emit('event', {
        action: 'load_profiles',
      })

    },
    debug_next_line (context: ActionContext) {
      let x: MyState = context.state


      let attempt_index = context.state.selected_index + 1

      context.commit('selected_index_will_change', attempt_index)
    },

    step_back_over (context: ActionContext) {
      let x: MyState = context.state
      let attempt_index = context.state.selected_index - 1

      let evt: CodeEvent = global_state.command_buffer[attempt_index]
      // seek backward
      attempt_index = seek_back_in_current_method(evt, attempt_index)
      context.commit('selected_index_will_change', attempt_index)

    },
    step_out_backwards (context: ActionContext) {

      let event_under_cursor: CodeEvent = global_state.command_buffer[context.state.selected_index]
      // same as step out in regular debugging session, but
      // in opposite direction

      let attempt_index = seek_step_out_backwards(event_under_cursor, context.state.selected_index)
      context.commit('selected_index_will_change', attempt_index)

    },
    step_out_forward (context: ActionContext) {

      let current_index = context.state.selected_index

      let current_event: CodeEvent = global_state.command_buffer[current_index]
      // this is same as step out in regular debugging session
      let new_index = seek_step_out_forward(current_event, current_index)
      context.commit('selected_index_will_change', new_index)

    },

    step_over (context: ActionContext) {
      let x: MyState = context.state
      let attempt_index = context.state.selected_index + 1

      let evt: CodeEvent = global_state.command_buffer[attempt_index]
      attempt_index = step_over_from_current_event(evt, attempt_index)
      context.commit('selected_index_will_change', attempt_index)
    },
    debug_previous_line (context: ActionContext) {
      context.commit('selected_index_will_change', context.state.selected_index - 1)
    },
  },
  getters: {
    is_panel_visible: (state: MyState) => panel => {
      return state.ui.is_panel_visible(panel)
    },
    short_filename: state => (full: string, until: number) => {
      if (typeof(full) === 'number') {
        return short(global_state.file_at(full), until)
      }
      return short(full, until)
    },
    file_from_id: state => (file_id: number) => {
      let found = global_state.file_at(file_id)
      if (found) {
        return found
      }
    },
    ignore_suggestions:  (state: MyState) => {
      let selected_event = state.selected_event
      if (selected_event) {
        // socket.emit('event', {
        //   action: 'load_file',
        //   file_to_load: selected_event.cursor.file,
        // })
        // return state.files.find((value: CodeFile) => value.filename === selected_event.cursor.file)
        let file_id = selected_event.cursor.file
        let found = global_state.file_at(file_id)
        if (found) {
          let result = parents(found, 5)
          return result
        }
      }
    },

    selected_file: (state: MyState) => {
      let selected_event = state.selected_event
      if (selected_event) {
        // socket.emit('event', {
        //   action: 'load_file',
        //   file_to_load: selected_event.cursor.file,
        // })
        let fileref = global_state.file_at(selected_event.cursor.file)
        return state.files.find((value: CodeFile) => value.filename === fileref)
      }
    },


  },
  modules: {
    // code_editor: {
    //   state: {
    //     selected_file: null
    //   }
    // },
  },
  strict: true,
})
