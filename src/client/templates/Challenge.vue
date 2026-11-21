<template>
  <b-container id="challenge">
    <b-row>
      <router-view id="current-stage"></router-view>
    </b-row>
    <!--
    <hr>
    <b-row>
      <div>
        TaskIndex: {{ taskIndex }}<br>
        StageIndex: {{ stageIndex }}<br>
        NewIndex: {{ newIndex }}
      </div>
      <div>
        <pre>{{ currentTasks }}</pre>
        <pre>{{ currentStages }}</pre>
      </div>
    </b-row>
    -->
  </b-container>
</template>

<script>
// TODO implement generic challenge
import Axios from 'axios';
import { isEqual } from 'lodash';

import ActionSender from '../services/ActionSender';
import EventBus from '../modules/eventBus';
import { registerChallengeCoordinator, runChallengeTransition } from '../modules/challengeCoordinator';
import Timer from '../services/Timer';

import * as Constants from '../services/Constants';
import { deepCopy, getObjectFromArray, isEmptyArray } from '../services/Utils';

export default {
  data() {
    return {
      challengePath: '/challenge',
      stageOrder: [
        { path: '/short-challenge/ready', query: { task: '' }},
        { path: '/short-challenge/description', query: { task: '' }},
        { path: '/short-challenge/taskform', query: { task: '', form: Constants.pretaskForm }},
        { path: '/short-challenge/query', query: { task: '', form: Constants.queryForm }},
        { path: '/short-challenge/taskform', query: { task: '', form: Constants.posttaskForm }}
      ],
      sessionFlow: null,
      currentTasks: this.$store.getters.tasks,
      currentStages: this.$store.getters.stages,
      taskIndex: 0,
      stageIndex: 0,
      newIndex: this.$store.getters.stageIndex,
      taskAmount: 3
    }
  },

  computed: {
    currentUser() {
      return this.$store.state.auth.user;
    },
    loggedIn() {
      return this.$store.state.auth.status.loggedIn;
    }
  },

  // dgacitua definitions
  // next-stage: Advance to the following global action (Consent, Demographic, TypingTest, ShortChallenge, etc.)
  // next-challenge: Advance to the following step inside a challenge (Short or Extended)
  created() {
    registerChallengeCoordinator(this.advanceChallenge);
  },

  mounted() {
    return runChallengeTransition(() => this.initializeChallenge());
  },

  // The coordinator intentionally survives navigation to sibling substages.
  methods: {
    async initializeChallenge() {
      try {
        await this.importSessionFlow();
        // Begin the challenge from start
        if (this.$store.getters.stageIndex == null) {
          // A partial assignment is not permission to shuffle the user's tasks again.
          if (this.$store.getters.tasks?.length || this.$store.getters.stages?.length) {
            throw new Error('Incomplete challenge snapshot');
          }
          await this.importTasks();
          this.createStages();
          await this.startChallenge();
        }
        // If user has already begun the challenge
        else {
          this.validateAssignment();
          await this.saveUserData();
          await this.loadChallenge();
        }
      }
      catch (err) {
        console.error(err);
        alert('An error ocurred while loading the challenge [Code 462-G0]');
      }
    },
    async advanceChallenge() {
      console.log('LETICIA Next Challenge!');

      try {
        this.nextChallenge();
        await this.saveUserData().catch(err => {
          this.$store.commit({ type: 'setStageIndex', amount: this.$store.getters.stageIndex - 1 });
          throw err;
        });
        await this.loadChallenge();
      }
      catch (err) {
        console.error(err);
        alert('An error ocurred while advancing the challenge [Code 462-SAVE]');
      }
    },
    importTasks() {
      return Axios.get(`${Constants.backendApiUrl}/tasks/shuffle?username=${this.currentUser.username}&num=${this.taskAmount}`)
        .then((res) => {
          this.$store.commit({ type: 'setTasks', tasks: res.data });
          console.log('Search Tasks loaded!');
          return Promise.resolve();
        })
        .catch((err) => {
          console.error(err);
          alert('An error ocurred while loading tasks [Code 462-G1]');
          return Promise.reject();
        });
    },
    importSessionFlow() {
      const flow = this.$store.getters.sessionFlow;
      if (flow && Array.isArray(flow.stages) && flow.stages.length) {
        this.sessionFlow = flow;
        return Promise.resolve();
      }
      if (this.$store.getters.stageIndex != null || this.$store.getters.tasks?.length) {
        return Promise.reject(new Error('Assigned challenge has no valid session flow'));
      }
      return Axios.get(`${Constants.backendApiUrl}/flows/${Constants.currentSessionFlow}`)
        .then((res) => {
          if (!Array.isArray(res.data?.stages) || !res.data.stages.length) {
            throw new Error('Invalid session flow');
          }
          this.sessionFlow = res.data;
          this.$store.commit({ type: 'setSessionFlow', sessionFlow: res.data });
          console.log('Session Flow (stages) loaded!', Constants.currentSessionFlow, this.sessionFlow);
          return Promise.resolve();
        })
        .catch((err) => {
          console.error(err);
          alert('An error ocurred while loading session flow [Code 462-G2]');
          return Promise.reject();
        });
    },
    createStages() {
      this.$store.commit({ type: 'setStages', stages: this.buildStages() });
    },
    validateAssignment() {
      const { stageIndex, tasks, stages, sessionFlow, flowIndex } = this.$store.getters;
      if (!Number.isInteger(stageIndex) || stageIndex < 0 || !tasks?.length ||
          !Array.isArray(stages) || stageIndex > stages.length ||
          sessionFlow.stages[flowIndex]?.path !== this.challengePath ||
          !isEqual(stages, this.buildStages())) {
        throw new Error('Challenge snapshot does not match the session flow; resume stopped');
      }
    },
    buildStages() {
      let userStages = [];
      this.$store.getters.tasks.forEach(el1 => {
        // Check for custom session flow
        if (!!(this.sessionFlow) && this.sessionFlow.hasOwnProperty('stages')) {
          // Load custom challenge stage
          let challengeObj = getObjectFromArray(this.sessionFlow.stages, 'path', this.challengePath);

          // If a custom challenge exists, use stages from challenge object
          if (!!(challengeObj) && challengeObj.hasOwnProperty('stages')) {
            challengeObj.stages.forEach(el2 => {
              let newStage = deepCopy(el2);
              
              newStage.query = {
                ...{ task: deepCopy(el1.searchTaskId) },
                ...deepCopy(newStage.query)
              };

              userStages.push(newStage);
            });
          }
          // If it doesn't, do regular challenge logic
          else {
            this.stageOrder.forEach(el2 => {
              let newStage = deepCopy(el2);
              newStage.query.task = deepCopy(el1.searchTaskId);
              userStages.push(newStage);
            });
          }          
        }
        // If it doesn't exists, do regular challenge logic
        else {
          this.stageOrder.forEach(el2 => {
            let newStage = deepCopy(el2);
            newStage.query.task = deepCopy(el1.searchTaskId);
            userStages.push(newStage);
          });
        }
      });
      
      return userStages;
    },
    async startChallenge() {
      this.$store.commit({ type: 'setStageIndex', amount: 0 });
      let nextStage = this.$store.getters.stages[this.$store.getters.stageIndex];
      console.log('StartChallenge!', nextStage);
      await this.saveUserData();
      return this.$router.replace(nextStage);
    },
    nextChallenge() {
      this.$store.commit({ type: 'nextStageIndex' });
      console.log('NextChallenge!', this.$store.getters.stageIndex);
    },
    loadChallenge() {
      let idx = this.$store.getters.stageIndex;
      let len = this.$store.getters.stages.length;

      if (idx < len) {
        let nextStage = this.$store.getters.stages[this.$store.getters.stageIndex];
        console.log('LoadChallenge!', this.$store.getters.stageIndex, nextStage);
        return this.$router.replace(nextStage);
      }
      else {
        EventBus.$emit('leticia-timer-stop');
        EventBus.$emit('leticia-next-stage');
      }
    },
    saveUserData() {
      let userdata = {
        username: this.currentUser.username,
        state: this.$store.getters.userData,
        sessionFlow: this.$store.getters.sessionFlow
      };

      return Axios.post(`${Constants.backendApiUrl}/userdata/${this.currentUser.username}`, userdata)
        .then(res => console.log('UserData saved on server!'))
        .catch(err => {
          console.error('Error while saving UserData on server', err);
          throw err;
        });
    }
  }
}
</script>

<style scoped>
</style>
