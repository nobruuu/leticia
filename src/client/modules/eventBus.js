import mitt from 'mitt';

const emitter = mitt();

// Keep the interface used by Vue 2 consumers during the stack migration.
const EventBus = {
  $on(event, handler) {
    emitter.on(event, handler);
    return EventBus;
  },
  $off(event, handler) {
    emitter.off(event, handler);
    return EventBus;
  },
  $emit(event, payload) {
    emitter.emit(event, payload);
    return EventBus;
  }
};

export default EventBus;
