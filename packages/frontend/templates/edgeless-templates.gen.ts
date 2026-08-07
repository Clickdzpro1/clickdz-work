import BugTriage from './edgeless/Bug Triage.json';
import DefinitionOfDone from './edgeless/Definition of Done.json';
import ImpedimentBoard from './edgeless/Impediment Board.json';
import KanbanBoard from './edgeless/Kanban Board.json';
import ReleasePlan from './edgeless/Release Plan.json';
import SprintBoard from './edgeless/Sprint Board.json';
import StoryMapping from './edgeless/Story Mapping.json';
import FiveWTwoH from './edgeless/5W2H.json';
import ConceptMap from './edgeless/Concept Map.json';
import Flowchart from './edgeless/Flowchart.json';
import SMART from './edgeless/SMART.json';
import SWOT from './edgeless/SWOT.json';
import CrazyEights from './edgeless/Crazy Eights.json';
import DesignCritique from './edgeless/Design Critique.json';
import EmpathyMap from './edgeless/Empathy Map.json';
import InformationArchitecture from './edgeless/Information Architecture.json';
import Moodboard from './edgeless/Moodboard.json';
import PersonaCanvas from './edgeless/Persona Canvas.json';
import UsabilityTestPlan from './edgeless/Usability Test Plan.json';
import WireframeKit from './edgeless/Wireframe Kit.json';
import ConceptReview from './edgeless/Concept Review.json';
import CornellNotes from './edgeless/Cornell Notes.json';
import GroupProjectBoard from './edgeless/Group Project Board.json';
import KWLChart from './edgeless/KWL Chart.json';
import LessonPlan from './edgeless/Lesson Plan.json';
import ReadingList from './edgeless/Reading List.json';
import StudyPlanner from './edgeless/Study Planner.json';
import FourPMarketingMatrix from './edgeless/4P Marketing Matrix.json';
import Storyboard from './edgeless/Storyboard.json';
import UserJourneyMap from './edgeless/User Journey Map.json';
import FourLsRetro from './edgeless/4Ls Retro.json';
import DailyStandup from './edgeless/Daily Standup.json';
import DecisionLog from './edgeless/Decision Log.json';
import IcebreakerBoard from './edgeless/Icebreaker Board.json';
import MadSadGlad from './edgeless/Mad Sad Glad.json';
import MeetingNotes from './edgeless/Meeting Notes.json';
import SprintRetrospective from './edgeless/Sprint Retrospective.json';
import StartStopContinue from './edgeless/Start Stop Continue.json';
import BucketList from './edgeless/Bucket List.json';
import BudgetBoard from './edgeless/Budget Board.json';
import GoalSetting from './edgeless/Goal Setting.json';
import HabitTracker from './edgeless/Habit Tracker.json';
import MealPlanner from './edgeless/Meal Planner.json';
import WeeklyPlanner from './edgeless/Weekly Planner.json';
import WellnessWheel from './edgeless/Wellness Wheel.json';
import BusinessProposal from './edgeless/Business Proposal.json';
import DataAnalysis from './edgeless/Data Analysis.json';
import SimplePresentation from './edgeless/Simple Presentation.json';
import FishboneDiagram from './edgeless/Fishbone Diagram.json';
import GanttChart from './edgeless/Gantt Chart.json';
import MonthlyCalendar from './edgeless/Monthly Calendar.json';
import ProjectPlanning from './edgeless/Project Planning.json';
import ProjectTrackingKanban from './edgeless/Project Tracking Kanban.json';
import BusinessModelCanvas from './edgeless/Business Model Canvas.json';
import LeanCanvas from './edgeless/Lean Canvas.json';
import OKRBoard from './edgeless/OKR Board.json';
import PorterFiveForces from './edgeless/Porter Five Forces.json';
import RiskRegister from './edgeless/Risk Register.json';
import SWOTGrid from './edgeless/SWOT Grid.json';
import StakeholderMap from './edgeless/Stakeholder Map.json';
import ValueChain from './edgeless/Value Chain.json';
import ContentCalendar from './edgeless/Content Calendar.json';
import CustomerJourney from './edgeless/Customer Journey.json';
import EventRunOfShow from './edgeless/Event Run of Show.json';
import OnboardingFlow from './edgeless/Onboarding Flow.json';
import ProcessFlow from './edgeless/Process Flow.json';
import ProjectTimeline from './edgeless/Project Timeline.json';
import RoadmapQuarters from './edgeless/Roadmap Quarters.json';

const templates = {
  'Agile & Kanban': [
    BugTriage,
    DefinitionOfDone,
    ImpedimentBoard,
    KanbanBoard,
    ReleasePlan,
    SprintBoard,
    StoryMapping
  ],
  'Brainstorming': [
    FiveWTwoH,
    ConceptMap,
    Flowchart,
    SMART,
    SWOT
  ],
  'Design & UX': [
    CrazyEights,
    DesignCritique,
    EmpathyMap,
    InformationArchitecture,
    Moodboard,
    PersonaCanvas,
    UsabilityTestPlan,
    WireframeKit
  ],
  'Education': [
    ConceptReview,
    CornellNotes,
    GroupProjectBoard,
    KWLChart,
    LessonPlan,
    ReadingList,
    StudyPlanner
  ],
  'Marketing': [
    FourPMarketingMatrix,
    Storyboard,
    UserJourneyMap
  ],
  'Meetings & Retros': [
    FourLsRetro,
    DailyStandup,
    DecisionLog,
    IcebreakerBoard,
    MadSadGlad,
    MeetingNotes,
    SprintRetrospective,
    StartStopContinue
  ],
  'Personal Planning': [
    BucketList,
    BudgetBoard,
    GoalSetting,
    HabitTracker,
    MealPlanner,
    WeeklyPlanner,
    WellnessWheel
  ],
  'Presentation': [
    BusinessProposal,
    DataAnalysis,
    SimplePresentation
  ],
  'Project Management': [
    FishboneDiagram,
    GanttChart,
    MonthlyCalendar,
    ProjectPlanning,
    ProjectTrackingKanban
  ],
  'Strategy & Org': [
    BusinessModelCanvas,
    LeanCanvas,
    OKRBoard,
    PorterFiveForces,
    RiskRegister,
    SWOTGrid,
    StakeholderMap,
    ValueChain
  ],
  'Timelines & Flows': [
    ContentCalendar,
    CustomerJourney,
    EventRunOfShow,
    OnboardingFlow,
    ProcessFlow,
    ProjectTimeline,
    RoadmapQuarters
  ]
}

function lcs(text1: string, text2: string) {
  const dp: number[][] = Array.from({ length: text1.length + 1 })
    .fill(null)
    .map(() => Array.from<number>({length: text2.length + 1}).fill(0));

  for (let i = 1; i <= text1.length; i++) {
    for (let j = 1; j <= text2.length; j++) {
      if (text1[i - 1] === text2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[text1.length][text2.length];
}

export const builtInTemplates = {
  list: async (category: string) => {
    // @ts-expect-error type should be asserted when using
    return templates[category] ?? []
  },

  categories: async () => {
    return Object.keys(templates)
  },

  search: async(query: string) => {
    const candidates: unknown[] = [];
    const cates = Object.keys(templates);

    query = query.toLowerCase();

    for(let cate of cates) {
      // @ts-expect-error type should be asserted when using
      const templatesOfCate = templates[cate];

      for(let temp of templatesOfCate) {
        if(lcs(query, temp.name.toLowerCase()) === query.length) {
          candidates.push(temp);
        }
      }
    }

    return candidates;
  },
}
