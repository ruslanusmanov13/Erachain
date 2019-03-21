package org.erachain.gui.items.polls;

import org.erachain.core.item.polls.PollCls;
import org.erachain.datachain.DCSet;
import org.erachain.gui.items.TableModelItemsSearch;

@SuppressWarnings("serial")
public class TableModelPolls extends TableModelItemsSearch {
    public static final int COLUMN_KEY = 0;
    public static final int COLUMN_NAME = 1;
    public static final int COLUMN_ADDRESS = 2;
    public static final int COLUMN_FAVORITE = 3;

    public TableModelPolls() {
        super(new String[]{"Key", "Name", "Creator", "Favorite"});
        super.COLUMN_FAVORITE = COLUMN_FAVORITE;
        db = DCSet.getInstance().getItemPollMap();
    }

    @Override
    public Object getValueAt(int row, int column) {
        if (this.list == null || row > this.list.size() - 1) {
            return null;
        }

        PollCls poll = (PollCls) this.list.get(row);

        switch (column) {
            case COLUMN_KEY:

                return poll.getKey();

            case COLUMN_NAME:

                return poll.viewName();

            case COLUMN_ADDRESS:

                return poll.getOwner().getPersonAsString();

            case COLUMN_FAVORITE:

                return poll.isFavorite();

        }

        return null;
    }

}
