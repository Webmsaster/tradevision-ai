//! 2026-05-17 Event-Bus for engine (lib-level; ftmo-event-engine has full impl).
//! Minimal in-core stub for reactive-stream pattern.
use std::collections::VecDeque;

pub trait Event: std::fmt::Debug + Send {}

pub struct EventQueue<E: Event> {
    queue: VecDeque<E>,
}
impl<E: Event> EventQueue<E> {
    pub fn new() -> Self {
        Self {
            queue: VecDeque::new(),
        }
    }
    pub fn push(&mut self, e: E) {
        self.queue.push_back(e);
    }
    pub fn pop(&mut self) -> Option<E> {
        self.queue.pop_front()
    }
    pub fn len(&self) -> usize {
        self.queue.len()
    }
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}
impl<E: Event> Default for EventQueue<E> {
    fn default() -> Self {
        Self::new()
    }
}
