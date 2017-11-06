package datachain;

import java.util.HashMap;
import java.util.Map;

import org.mapdb.DB;

import core.voting.Poll;
import utils.ObserverMessage;
import database.DBMap;
import database.serializer.PollSerializer;
import datachain.DCSet;

public class PollMap extends DCMap<String, Poll> 
{
	private Map<Integer, Integer> observableData = new HashMap<Integer, Integer>();
	
	public PollMap(DCSet databaseSet, DB database)
	{
		super(databaseSet, database);
		
		if (databaseSet.isWithObserver()) {
			this.observableData.put(DBMap.NOTIFY_RESET, ObserverMessage.RESET_POLL_TYPE);
			if (databaseSet.isDynamicGUI()) {
				this.observableData.put(DBMap.NOTIFY_ADD, ObserverMessage.ADD_POLL_TYPE);
				this.observableData.put(DBMap.NOTIFY_REMOVE, ObserverMessage.REMOVE_POLL_TYPE);
			}
			this.observableData.put(DBMap.NOTIFY_LIST, ObserverMessage.LIST_POLL_TYPE);
		}
	}

	public PollMap(PollMap parent) 
	{
		super(parent, null);
	}
	
	protected void createIndexes(DB database)
	{
		//VOTES INDEX
		/*final NavigableSet<Tuple2<BigDecimal, String>> namesIndex = database.createTreeSet("polls_index_votes")
				.comparator(Fun.COMPARATOR)
				.makeOrGet();
				
		final NavigableSet<Tuple2<BigDecimal, String>> descendingNamesIndex = database.createTreeSet("polls_index_votes_descending")
				.comparator(new ReverseComparator(Fun.COMPARATOR))
				.makeOrGet();
				
		createIndex(VOTES_INDEX, namesIndex, descendingNamesIndex, new Fun.Function2<BigDecimal, String, Poll>() {
		   	@Override
		    public BigDecimal run(String key, Poll value) {
		   		return value.getTotalVotes();
		    }
		});
		
		//REMOVE PREVIOUS VOTES INDEX ON UPDATE
		((BTreeMap) this.map).modificationListenerAdd(new Bind.MapListener<String, Poll>() {

			@Override
			public void update(String key, Poll oldPoll, Poll newPoll) {
				
				//CHECK IF UPDATE
				if(oldPoll != null && newPoll != null)
				{
					//REMOVE PREVIOUS INDEX
					boolean result1 = namesIndex.remove(new Tuple2<BigDecimal, String>(oldPoll.getTotalVotes(), key));
					boolean result2 = descendingNamesIndex.remove(new Tuple2<BigDecimal, String>(oldPoll.getTotalVotes(), key));
				}				
			}
		});*/
	}

	@Override
	protected Map<String, Poll> getMap(DB database) 
	{
		//OPEN MAP
		return database.createTreeMap("polls")
				.valueSerializer(new PollSerializer())
				.counterEnable()
				.makeOrGet();
	}

	@Override
	protected Map<String, Poll> getMemoryMap() 
	{
		return new HashMap<String, Poll>();
	}

	@Override
	protected Poll getDefaultValue() 
	{
		return null;
	}
	
	@Override
	protected Map<Integer, Integer> getObservableData() 
	{
		return this.observableData;
	}

	public boolean contains(Poll poll) {
		return this.contains(poll.getName());
	}

	public void add(Poll poll) {
		this.set(poll.getName(), poll);
	}
	
	public void delete(Poll poll) {
		this.delete(poll.getName());
	}
}